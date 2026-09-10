# Operating reading-lite

Deploying, ingesting in bulk, and repairing the corpus. `README.md` covers
first use; [architecture](architecture.md) and [API](api.md) hold the technical
references. This document is the operator runbook.

Operator workflows run through the unified plan-first CLI: `npm run ops --
<group> <command> [options]`. Every command with durable side effects prints a
plan by default and acts only with `--execute`.

### Operator Node

`npm run ops` is supported on **Node 20.19.x** (`/usr/bin/node` on Debian).
That is the supported operator path. Do not upgrade the operator laptop to
Node 22. It will not launch under the security boundary Snipe runs in.

Wrangler 4.87+ hard-fails in `bin/wrangler.js` on Node < 22. Ops does not
spawn that wrapper: it execs `node_modules/wrangler/wrangler-dist/cli.js`
with the current Node (see `scripts/lib/wrangler-cli.ts`). Corpus, deploy,
staging, and founder commands therefore run on 20.19.x. Wrangler may print
a Node 22 warning on the banner; that is wrangler's advertised floor, not a
reading-lite failure. CI remains Node 22. The production Worker stays on
workerd.

`package.json` `engines.node` is `>=20.19.0` so npm does not reject Node 20.

Every `corpus` command additionally requires `--tenant <selector>` before it
plans anything. There is no default. A missing or malformed selector is a
usage error (exit 2) before any R2 or Vectorize traffic, so an operator can
never act on the wrong corpus by omission.

A `usr_…` tenant id addresses that tenant's `u/{tenantId}/` key namespace plus
its Vectorize namespace (the same roots the worker derives from a validated
`TenantContext`). `global` is the pre-tenant layout selector: local (where
`TENANT_DATA_PLANE` is still unset), and the leftover global objects both
deployed environments retain, production's pending signed-off deletion,
staging's kept by its own copy-only migration.
On a gate-on environment `global` is a direct-R2 selector only: realtime write
paths reject it (`verifyRealtimeTenant`, `scripts/corpus-lib/realtime-tenant.ts`).

Production has been cut over (`TENANT_DATA_PLANE=1` pinned 2026-08-31). Live
production corpus commands use the founder tenant from a production bearer,
not `global`:

```sh
# Resolve $TENANT once. Copy this into production corpus commands; do not
# copy --tenant global onto the live founder corpus.
TOKEN=$(grep ^READER_API_TOKEN= .prd.vars | cut -d= -f2-)
curl -sS -A curl/8 -H "Authorization: Bearer $TOKEN" \
  https://readinglite.ai/api/whoami
# Record tenant_id as TENANT (usr_…). Expect tenant_data_plane true.
```

Then `--tenant "$TENANT"`.

## Account deletion

`DELETE /api/account` marks the account deleting and revokes its credentials.
The founder and staging fixtures follow the same path as every other tenant.
The request does not enqueue a wipe. Every 15 minutes, cron starts eligible
`ACCOUNT_WIPE_JOBS` work after the seven-day `deleting_at_ms` grace period.
`{ force: true }` skips grace for a new wipe. Cron resumes unfinished or reopened
wipes during grace and preserves the record's force flag.

The wipe refuses an unset tenant gate or empty key root with `no_tenant_prefix`.
It never falls back to global R2 keys or unnamespaced vectors. A missing
`READINGS_INDEX` throws `index_unbound` before any object deletion, including
on a resumed objects phase. A deleting user with no deletion timestamp logs
`account_wipe_missing_deleting_at`; investigate before repairing the timestamp
or forcing the wipe.

### Progress, seeding, and confirmation

D1 `wipe_progress` holds the seed/object cursors, phase, lease sequence,
heartbeat, probe/continuation counts, force flag, and completion. The old
`vector_cursor` column is retired and remains NULL. Writes compare and advance
`lease_seq`; a delivery that loses ownership reports `lease_held` and acks.
The queue consumer runs at concurrency 1. `updated_at_ms` is advisory for cron,
not proof that a job has ended, even after a long delayed retry.

Heartbeats are throttled to one minute. Cursor, phase, lease, continuation,
probe, and completion updates persist whenever a later delivery needs them.
`ACCOUNT_WIPE_MAX_CONTINUATIONS` bounds self-sent continuation messages so a
stalled wipe cannot reset its retry budget forever. Exceeding that bound throws
and eventually reaches the wipe DLQ, which logs and acks without touching reading
manifests. Reopening resets the continuation count and repeats seeding.

Before either deletion phase, the wipe pages its tenant R2 root, derives IDs
with `readingIdFromRelativeKey`, and inserts missing vector-ledger rows.
Existing rows, including delete stamps and confirmation streaks, remain intact.
Seeding resumes from `seed_cursor` and finishes at `seed_completed_at_ms`.
No reading object is deleted before its ID is in the ledger.

`account_wipe_ledger_seeded` reports `rows_created`. Nonzero is expected for a
corpus predating the ledger; investigate it on a corpus whose writers should
have covered every ID. Operator seeding is a live-tenant repair or rehearsal
option, never a wipe prerequisite:

```sh
npm run ops -- corpus seed-vector-ledger --tenant "$TENANT" --bucket reading-lite
npm run ops -- corpus seed-vector-ledger --tenant "$TENANT" --bucket reading-lite --execute
```

The operator command uses the same insert-only helper and refuses `global`.
Extra ledger rows cost harmless delete requests; missing rows can leave vectors
unaddressable by the wipe.

The vector phase selects live ledger rows, submits composed-ID `deleteByIds`,
and marks each batch `delete_submitted`. That query advances itself without a
vector cursor. Vector deletes precede paged R2 deletion. The publisher also
removes its vector promptly when it detects account deletion; the durable
ledger lets later cleanup address a missed publisher compensation.

Clean completion requires both an empty ledger and a clean namespace probe.
The probe runs even with an empty ledger. Confirmation follows the measured
constants in `src/control-plane/vector-ledger.ts`:

- Wait at least 120 seconds after delete submission before counting confirmation.
- An empty namespaced query clears only `delete_submitted` rows, never live rows.
- Otherwise, `getByIds` requests contain at most 20 IDs. Clearing a row needs two
  successful absent observations at least 60 seconds apart. Non-200 responses
  provide no absence evidence and reset the streak.
- Retry backoff is 120, 240, then 480 seconds, capped at four confirmation
  attempts. That bound must stay strictly below the wipe queue's `max_retries`,
  currently six, because first-confirmation deferral and transient retries do
  not all spend a probe attempt.

`describe()`, `vectorCount`, and `processedUpToMutation` are not confirmation
signals; staging measurements saw them move backwards between replicas.
At the confirmation bound, the wipe logs `account_wipe_namespace_residue` with
tenant ID only, completes with `residue=1`, and retains unconfirmed ledger rows
for repair. `probe_saw_residue` records whether a probe saw vectors rather than
only errors. Completion with residue requires investigation; it is not a clean
namespace certification.

`completed_at_ms` and `residue` describe current completion and clear on reopen.
`first_completed_at_ms` and `first_residue` are written once and pinned in SQL.
Teardown gates on current completion; reports preserve first-completion history.
Completion clears cursors and keeps the progress row until teardown.

### Control-plane teardown and email reuse

Cron runs `src/control-plane/account-teardown.ts` after wipe completion and an
empty-prefix check. A failure retries on the next tick. Teardown also runs for
a completed `residue=1` wipe; it copies that flag to the audit record and retains
unconfirmed vector-ledger rows.

1. Write `account_deletions` first. It retains tenant ID, deletion/completion/
   teardown timestamps, and current/first residue flags. It has no foreign key,
   email, display name, or reading IDs. Its presence proves an attempt, not
   successful teardown.
2. Purge the tenant's TenantUsageGuard storage/alarm and its GlobalUsageGuard
   leases and spend records. Guard errors stop teardown before D1 deletion.
   Incurred charges remain in the global daily aggregate. AuthRateGuard retains
   hashed TTL-windowed email/IP counters because it has no tenant key.
3. Resolve owned address history, then recheck the R2 prefix immediately before
   `db.batch`. Only confirmed-empty permits the batch. Leftover objects reopen
   the wipe on a later tick; unknown/error observations leave teardown for retry.
4. Delete child rows before parents in one D1 batch: token scopes/tokens,
   sessions, challenges, digest deliveries, relationship refresh checkpoints,
   settings, limits, eligible invites,
   wipe progress, then users. D1 enforces foreign keys; none cascade.
   Migration 0012 lets unconfirmed vector-ledger rows outlive users.

An object arriving between the final prefix verdict and D1 commit can still be
orphaned after cron loses the users row it enumerates. The recheck narrows this
race; it does not close it. Keep that #261 limit in deletion reports.

The current address remains unavailable until the users row is gone. Under
`invite_only`, returning users need a fresh invite after teardown. Check directly:

```sql
SELECT 1 FROM users WHERE id = '<tenant>';   -- must return no row
```

Do not rely on the earlier audit row or a non-durable completion log. An invite
created for the current address while the account is still deleting will be
removed by teardown, even if unconsumed. After confirming absence, a new invite
uses the existing schema:

```sql
INSERT INTO signup_invites (email_canonical, email_display, created_at_ms)
VALUES (?, ?, ?);
```

Teardown also frees proven prior addresses from redeemed or login challenges.
An unredeemed email-change request does not prove address ownership. It removes
consumed invites for proven addresses and any invite on the current address;
unconsumed invites on previously released addresses survive because they may
belong to a new recipient. A consumed marker on a released address can belong
to a later registrant, but removing that spent marker does not affect their
existing users row. Making attribution exact needs invite ownership in the schema.

Some signup-era, superseded challenges have no owner and cannot be attributed
after an address change. Sweeping them by a released address could remove
another person's challenge. Preserve this known retention limit in reports.
The [email-reuse drill](evidence/286-staging-email-reuse-2026-09-05.md) and
[second run](evidence/286-staging-email-reuse-followup-2026-09-05.md) record the
verified behavior; they did not exercise an invite inserted during deletion.

### Legacy data and bare vectors

Wipe seeding cannot recover an ID from R2 after all its objects are gone.
The operator audit can discover namespaced orphans through a full vector-ID
inventory; that capability does not make the wipe's own ledger complete.

Older tenant batch writers used bare IDs. Those vectors can survive a composed-ID
wipe or duplicate a live reading's match alongside its composed vector. Do not
fix them by deleting every bare ID: IDs are index-unique, deletion is namespace-
blind, and an unnamespaced bare vector may be part of the protected legacy copy.
Use the audit/repair rules below. Legacy global deletion still needs separate
sign-off under #285; routine tenant operations must not erode that copy.

The [2026-09-05 production audit](evidence/195-production-audit-2026-09-05.md)
found no tenant bare-vector repair candidates and all 557 then-ready readings
had composed vectors. That is dated evidence, not a current inventory. Accepted
[staging evidence and limits](staging-evidence-contract.md) do not require a new
deletion drill for an unrelated release.

### Account residue scan and bare-vector repair (S5)

These commands implement the local operator surface for [#195](https://github.com/brian-bell/reading-lite/issues/195)
and design [#263](https://github.com/brian-bell/reading-lite/issues/263).
The dated staging and production evidence linked below records the approved
operator work and its accepted limits. Fresh repairs require a reviewed plan.

```sh
npm run ops -- account residue-scan --tenant "$TENANT" --bucket reading-lite-staging
npm run ops -- account residue-scan --all-deleted --bucket reading-lite-staging
npm run ops -- account audit-bare-vectors --namespace "$TENANT" --bucket reading-lite-staging
```

The scan prints JSON findings separately for tenant R2, old tenant `wipe/`
records, ledger rows (including `delete_submitted` rows from individual purges),
a namespace query, a full vector ID inventory, per-reading vector observations,
and every D1 table touched by teardown. `account_deletions` is expected retained
audit evidence. Its `first_completed_at_ms` / `first_residue` describe history;
`residue = 1` in that record is not a measurement of today's namespace. An audit
row is written *before* teardown and does not itself prove teardown completed.
Remaining users/child/progress rows mean control-plane cleanup is still pending
or incomplete; they are reported even during the normal interval before cron.
On a live tenant the ordinary corpus and D1 rows naturally report as present.

Exit status is **1 for residue or incomplete visibility**, 2 for invalid usage,
and 0 only when all scanned sources are clear or expected. The residue-scan command
does not independently inspect TenantUsageGuard storage/alarms or GlobalUsageGuard
leases. The separate private `system status --details` command now inspects quotas
and leases, but is not integrated into this scanner and does not certify alarm
absence. The scanner leaves those sources unknown, so it can report zero
observed data and still exit 1. Teardown's fail-closed DO purge is useful evidence, not a direct inspection.
AuthRateGuard's hashed windows are not attributable to one tenant. After address
history/token ownership is erased, released-address invites, NULL-owner
challenges and orphan token scopes cannot be fully attributed; S4's documented
spent-invite residual may be inert. Queues and concurrent work are not inspected.
These limitations must accompany any closeout report; do not relabel exit 1 as
an unconditional clean certification.

A ready list entry whose composed vector is absent is reported by reading ID
under `listed_vectors`, even without a ledger row. This catches the observable
shape of a purge whose vector delete succeeded and `markDeleteSubmitted` failed.
The scan cannot distinguish that intent from propagation delay or other vector
drift. Its single reads are candidate absences, not S3's two spaced successful
confirmations. It neither retires ledger rows nor repairs listed readings.

Cloudflare now supports [paginated vector ID listing](https://developers.cloudflare.com/vectorize/best-practices/list-vectors/).
The audit enumerates the **whole index snapshot**, retrieves vectors through
`get_by_ids` in chunks of at most 20, and selects their actual namespace. There
is no namespace filter on the list endpoint. Discovery does not depend on ledger
rows, which a prior wipe may have cleared, or a bounded similarity query.
Snapshot pagination excludes subsequent inserts; a listed ID missing during
hydration is unknown and blocks repair. HTTP/schema/cursor errors fail closed.
A fresh invocation captures a fresh snapshot. This can find previously orphaned
namespaced vectors even when R2 and the ledger are empty. Unnamespaced ownership
remains outside the tenant scan and belongs to S7.

The audit reports bare/composed pairs, including a composed tenant vector paired
with a protected global vector. A bare vector is repairable only when its actual
namespace matches the requested tenant and its reading ID is absent from the
retained global R2 list/by-id/reading-key inventory. Any protected candidate
blocks execution of that plan. Malformed global inventory also blocks execution.
This conservatively preserves the pre-cutover set, including readings whose bare
vector was subsequently moved into a tenant namespace. S7 approval is required
for those; this command has no override for legacy deletion.

For an approved staging repair, first pause and drain **all** realtime and
offline writers and wipe/teardown jobs. Hold that pause across all passes:

```sh
npm run ops -- account audit-bare-vectors --namespace "$TENANT" --bucket reading-lite-staging
npm run ops -- account audit-bare-vectors --namespace "$TENANT" --bucket reading-lite-staging --execute --confirm "$TENANT" --sole-writer
```

`--sole-writer` asserts that pause; the CLI cannot acquire a distributed lock.
Vectorize IDs are globally unique, deletion has no namespace argument or CAS,
and a read-before-delete alone cannot protect against another writer moving an
ID. Without the pause, do not execute. The command rechecks the payload,
namespace, tenant status and legacy membership before each mutation.

For an active tenant, repair requires a ready list entry and refuses a
`delete_submitted` ledger row, so it cannot resurrect a purged reading or reset
its confirmation state. It writes the ledger before upserting the composed copy. It retains the bare vector and exits 1 with `upsert_submitted`. After
propagation, re-run the plan and approved execution: only an identical composed
vector (values and metadata) permits deletion of the bare copy. A conflicting
copy is refused for review. For deleting tenants, or tenants absent from users
but present in `account_deletions`, repair deletes only the confirmed tenant bare
vector and never recreates a composed vector. It does not clear ledger rows.
`delete_submitted` is an async request, not proof of absence: repeat the audit
after propagation and record that evidence before resuming writers. A crash is
recoverable by re-planning; there is no blind delete based on an old plan file.

The forced wipe command queues the existing consumer, preserving its S1 fence,
S2 completion record and S3 seed/confirmation rules:

```sh
npm run ops -- account wipe --tenant "$TENANT" --bucket reading-lite-staging --force
npm run ops -- account wipe --tenant "$TENANT" --bucket reading-lite-staging --force --execute --confirm "$TENANT" --queue-id "$WIPE_QUEUE_ID"
```

It accepts only a tenant already `deleting`. `--force` skips the seven-day start
grace only. The queue ID is checked against `reading-lite-staging-wipe` (or
`reading-lite-wipe` for production) before enqueue. It never marks an active
user deleting and never changes a progress row. Enqueue success is not wipe
completion; cron runs teardown after the consumer completes.

After deletion: scan once after the data-plane completion, then scan again after
cron teardown. Confirm that users/child/progress rows disappeared and that the
first-completion pair survived in `account_deletions`. Resolve vector residue
and record DO/visibility limitations separately. For production preparation,
use the same commands with `--bucket reading-lite`, beginning with these reads:

```sh
npm run ops -- account audit-bare-vectors --namespace "$TENANT" --bucket reading-lite
npm run ops -- account residue-scan --tenant "$TENANT" --bucket reading-lite
npm run ops -- account residue-scan --all-deleted --bucket reading-lite
```

Use production-scoped credentials supplied by the operator; the checkout's
`.corpus.vars` may be staging-scoped. R2 uses the existing corpus credential
resolver; Vectorize/queue REST use `CORPUS_VECTORIZE_ACCOUNT_ID`, then
`CORPUS_R2_ACCOUNT_ID`, then `CLOUDFLARE_ACCOUNT_ID`, and `CORPUS_CF_API_TOKEN`
or `CLOUDFLARE_API_TOKEN`. D1 uses the existing Wrangler environment mapping.
The bucket fixes the Vectorize index and queue name; no index override is
accepted. Ensure all credentials identify the same account/environment.
Run the production repair only after separate approval, using the same explicit
execute/confirm/sole-writer controls. Resolve protected legacy candidates under
S7's separate approval; a refused plan is not a repaired corpus.

The separately executed
[2026-09-05 production read-only audit](evidence/195-production-audit-2026-09-05.md)
found no tenant bare-vector repair candidates and all 557 ready readings had
composed vectors. It records protected legacy pairs, the empty all-deleted
selection, the live ledger follow-up, and the scanner's certification limits.

### Sweeping old R2 wipe records

Wipe progress moved from `wipe/{tenantId}/progress.json` to D1. The current
Worker neither reads nor writes those R2 records. Before sweeping, confirm that
version is deployed and no older wipe invocation can still write the prefix.
Never sweep records used by an older Worker, even if their heartbeat is stale;
a stale record can be due for resume.

```sh
npm run ops -- account sweep-wipe-prefix --bucket reading-lite-staging
npm run ops -- account sweep-wipe-prefix --bucket reading-lite-staging \
  --execute --acknowledge-no-active-wipe
```

Plan lists keys, sizes, modification times, and a matching D1 progress query.
The acknowledgement asserts the deployment and absence of an active old wipe;
the command does not establish those facts. A users-status count is insufficient:
completed wipes can still have deleting users, and queued/delayed work can remain.
Check unfinished `wipe_progress` rows and queues as well. The
[production workflow wipe check](#deploying) is a separate deployment snapshot,
not a maintenance lock, and direct deploy commands do not run it automatically.

Execute deletes the listed keys and re-lists. Remaining keys produce a nonzero
exit. Same-key/same-ETag survivors can be retried after inspection; new or rewritten
keys mean a writer was active after planning and must be investigated before
another delete. R2 has no conditional delete, so an empty verification listing
proves absence, not that a concurrent write was unharmed.

Only literal `wipe/` keys are accepted. A tenant key or global corpus key in the
listing aborts before deletion; there is no override for a refused key. Inspect
and separately authorize any manual deletion. The command takes no `--tenant`
and defaults to production bucket `reading-lite`; specify staging for rehearsals.

A rollback to the old R2-progress Worker shares no lease with D1 progress.
Drain queues and stop in-flight work before such a rollback. Switching the tenant
gate off prevents new wipe entry but cannot cancel an invocation already running;
it also has the corpus-visibility costs described under [environments](#environments).

One caveat: `corpus recover`'s realtime path writes through the Reading API,
where the acting tenant is the **bearer token's** principal, not `--tenant`.
Before submitting, a realtime `--execute` therefore asks the worker who the
token is (authenticated `GET /api/whoami`, which also reports whether the
tenant data-plane gate is on) and fails closed on any mismatch: a `usr_…`
selector requires the gate on and the token's tenant equal to the selector;
`global` requires the gate off (with it on, every API write lands in the
token's tenant namespace, never the global layout). The verified layout is
then pinned onto every write via the `x-expected-tenant` header, which the
worker checks atomically per request, so a gate flip or rolling deploy
mid-run rejects later writes (412) instead of silently re-routing them. (The
pin protects only once every serving worker version enforces it: never flip
`TENANT_DATA_PLANE` in the same deploy that ships the pin, automatic under
the s1k.6 sequencing, where the flip comes well after.)
`--batch` is scoped by `--tenant` end to end and needs no verification.
(reading-lite-1xk)

## Environments

| Environment | Worker | Bucket / Vectorize index | Notes |
|---|---|---|---|
| local | `reading-lite-dev` | Miniflare-emulated R2 only | no Queue, no Vectorize |
| staging | `reading-lite-staging` | `reading-lite-staging` | canonical `staging.readinglite.ai` (Pages + `/api/*` `/health` `/mcp*`); also `staging.readinglite.app`; `reading-lite-staging.bbell.dev` retained |
| production | `reading-lite` | `reading-lite` | canonical `readinglite.ai` (`/api/*` + `/health` + `/mcp*`); also `readinglite.app`; `reading-lite.bbell.dev` retained for compatibility/rollback |

Environments do **not** inherit top-level `[vars]` or bindings, `wrangler.toml`
repeats them per environment. The distinct dev Worker name guards against an
accidental bare `wrangler deploy` clobbering production.

`TENANT_DATA_PLANE=1` prefixes hosted R2 keys as `u/{tenantId}/…`. Production
pins it in `[env.production.vars]` since the founder cutover (2026-08-31,
`docs/founder-cutover.md`); staging pins it too, so the destructive
account-wipe path can be rehearsed there ("Rehearsing account deletion on
staging"). Only local stays unset. After either pin, new writes land only
under tenant R2/Vectorize, rolling the gate back is a complete rollback only
before those writes resume; after them, freeze + reverse reconciliation or
explicit acceptance of loss. Workers-pool tests
turn it on so two tenants can share a URL without colliding. Operator corpus
scripts address whichever root their required `--tenant` selector names: the
tenant id from whoami for production and staging (gate on), and `global` for
local and for the retained pre-tenant objects both deployed environments still
carry.

### Secrets

Runtime Worker secrets (`wrangler secret put --env staging|production`):

| Secret | When |
|---|---|
| `AUTH_ROOT_SECRET` | always, 256-bit hex HKDF root for credential HMACs |
| `AUTH_PREVIOUS_ROOT_SECRET` | optional, previous root during a bounded rotation window |
| `OPENAI_API_KEY` | always, embeddings, and the default OpenAI summarizer |
| `ANTHROPIC_API_KEY` | only when `SUMMARIZER_PROVIDER=anthropic` |
| `X_API_BEARER_TOKEN` | only for `x.com` / `twitter.com` status URL imports |
| `RESEND_API_KEY` | required on staging/production, magic-link auth mail and per-reading notifications (recipient is `users.email_display`, never `EMAIL_TO`) |
| `TURNSTILE_SECRET_KEY` | required to send open-mode magic-link mail on staging/production. Cloudflare siteverify secret (**never** in `[vars]`). Local skip/fail-open when unset; staging/production fail-closed (missing secret, siteverify errors, or `success ≠ true` → no-send `{ok:true}`) |

Public widget key `TURNSTILE_SITE_KEY` is a `[vars]` value, not a secret.
`GET /api/auth/login-options` returns `{ turnstile_site_key }` only when
`signup_mode` is `open` and the key is configured; otherwise the field is
`null`. It never reports whether an email exists. Staging bootstrap stays
`invite_only` (`signupModeForEnv`); do not flip staging to open by default.

Checked-in summarizer effort vars in `wrangler.toml` (and the dotenv examples):
`OPENAI_SUMMARIZATION_REASONING_EFFORT` is `low` locally and `high` in
staging/production. `ANTHROPIC_SUMMARIZATION_REASONING_EFFORT` uses the same
defaults and is applied only when `SUMMARIZER_PROVIDER=anthropic`. Claude Sonnet
5 (`ANTHROPIC_MODEL=claude-sonnet-5`) accepts `low`, `medium`, `high`, `xhigh`,
or `max` on `output_config.effort`; invalid values, efforts the configured
model cannot take, and model/effort pairs that 400 with
`thinking: { type: "disabled" }` (Fable 5, Mythos 5, Mythos Preview; Opus 5 at
`xhigh` or `max`) fail closed before any source fetch or upstream spend.

Optional version vars (`AUTH_ROOT_KEY_VERSION`, `AUTH_PREVIOUS_ROOT_KEY_VERSION`)
default to `1`. HKDF includes the version, so a secret-only rotation must keep
the previous root on the same version the tokens were minted with (the default).
Bump both version vars explicitly when advancing the key generation.

`founder-bootstrap` cannot read Wrangler secrets. Put the **same**
`AUTH_ROOT_SECRET` plus `READER_API_TOKEN` (and `FOUNDER_EMAIL` unless you pass
`--email`) in `.stg.vars` / `.prd.vars` or the process environment. A local
root that differs from the Worker secret produces HMACs the Worker cannot
verify. After import, `READER_API_TOKEN` is not a runtime Worker fallback;
keep it in the dotenv for operator CLIs that still POST that bearer.

`POST /api/readings` requests notification by default (`email: true`). Send-time
`to` is the current verified `users.email_display`, `EMAIL_TO` is never a
fallback. Import is always silent even if the body or `--email` is true.
`notify_immediate=0`, `email: false`, a missing settings row, an inactive or
unverified user, an empty `EMAIL_FROM`, or a staging `AUTH_MAIL_ALLOWLIST` miss
all skip send (no `send_email` event). Resend failures still log a failed
`send_email` event with recipients redacted; the reading stays `ready` and the
job is not requeued.

Scheduled digests also go through Resend to the current verified
`email_display`, never `EMAIL_TO`, independent of `notify_immediate`, and
never `LOCAL_MAIL_SINK`. An empty window skips without mail and closes the
period in `digest_deliveries`. Resend 429 retries the digest job and leaves
the ledger `pending`. Fan-out re-enqueues leftover pending only after 15
minutes (`DIGEST_PENDING_STALE_MS`, one cron interval). Digest Resend POSTs
set `Idempotency-Key` to `userId:cadence:period_key`.

The offline corpus tools authenticate directly against Cloudflare rather than
through the Worker, and read `CORPUS_R2_ACCOUNT_ID`, `CORPUS_R2_ACCESS_KEY`,
`CORPUS_R2_SECRET_KEY`, and `CORPUS_CF_API_TOKEN` from the environment or
`.corpus.vars`.

### Deploying

Bring the control plane up before deploying a Worker that authenticates
against D1. `ops deploy worker` does not create the database or import the
founder token. `--execute` applies pending remote D1 migrations, then
uploads, and refuses placeholder `CONTROL_PLANE` `database_id` values in
`wrangler.toml`.

#### Tenant-mode activation guard

Before remote migrations or upload, `ops deploy worker --execute` inspects
the target environment's tenant-mode activation state. A single active version
serving 100% of traffic with `TENANT_DATA_PLANE=1`, matching `READINGS_BUCKET`,
`READINGS_INDEX`, and `CONTROL_PLANE` bindings, establishes the baseline for an
ordinary redeployment. The R2 bucket and Vectorize index must also have creation
timestamps no later than that version, so recreating either resource under its
old name requires fresh verification. Existing production and staging cutovers
use this baseline; no new migration or certification record is needed.

Off→on activation, changed resources, split deployments, missing deployment
state, and failed/incomplete API reads refuse execution with exit 2. When
activation is unverified, the preflight queries the target D1 database and
reports tenant IDs in `status='deleting'` at or past the seven-day grace window.
If that query fails (including a new database without the schema), it reports
eligibility as unavailable, not zero. This is an activation warning; ongoing
active-wipe deployment policy belongs to #269.

To proceed after a refusal, verify the intended corpus in the target tenant R2
root and Vectorize namespace, and review deletion eligibility in the target D1
database. For a rebuilt environment, verify its restored tenant corpus before
activation. The completed founder cutover is historical evidence, not a step to
repeat: its one-time migration command is retired. Any future conversion from a
legacy layout requires a separately scoped migration and rehearsal.
An intentionally empty new environment needs verification that no corpus is
expected. Record the evidence with the operational work, then explicitly use:

```sh
npm run ops -- deploy worker --env staging --execute --acknowledge-tenant-migration
```

Use `--env production` for a reviewed production activation. The acknowledgement
applies to this invocation only and is logged; it also acknowledges any deletion
eligibility that had to be checked manually. Do not add it to routine CI commands.
After successful activation the active version becomes the redeployment baseline.

The preflight uses `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in CI, or
Wrangler's current authentication locally. If account selection is ambiguous,
set `CLOUDFLARE_ACCOUNT_ID`. Credentials need Workers deployment/version read
access, R2 bucket metadata read access, Vectorize index read access, and D1 query
access for activation warnings. A permission failure requires correcting access
or manually verifying readiness before using the explicit acknowledgement.
Plan mode prints the check it would perform and runs the existing build dry-run;
it does not inspect remote readiness or require these read permissions.

This guard does not scan or certify corpus contents. Retained global objects
and un-namespaced vectors are allowed, and ordinary tenant writes/deletions need
not match the historical global snapshot. Direct Wrangler/API deployments can
bypass the guard; resource or data changes outside the deployment path are not
audited. Creation timestamps detect recreation since the active version, not
in-place data loss or a rebuild already followed by an out-of-band deployment.
The check is not a lock against concurrent administrative changes. Follow the
cutover runbook for those operations; never treat this preflight as a corpus
integrity audit or authorization to remove legacy data.

Staging:

```sh
cp .stg.vars.example .stg.vars   # AUTH_ROOT_SECRET, READER_API_TOKEN, FOUNDER_EMAIL, …
wrangler d1 create reading-lite-control-staging
# replace [env.staging] CONTROL_PLANE database_id in wrangler.toml
wrangler secret put AUTH_ROOT_SECRET --env staging   # same hex as .stg.vars
wrangler d1 migrations apply reading-lite-control-staging --env staging --remote
npm run ops -- founder bootstrap --email founder@example.com --env staging --execute
npm run ops -- deploy worker --env staging --execute
npm run ops -- deploy web --branch staging --execute
```

`deploy web --branch staging` is what creates the Pages preview named `staging`
on project `reading-lite`. There is no separate Pages project. After that
preview exists, bind `staging.readinglite.ai` and `staging.readinglite.app` to
it (not to `main`). A first-time preview deploy does not move existing custom
domains; re-point them in the dashboard if they were bound to production.

Production is the same sequence with `reading-lite-control`, `--env production`,
`.prd.vars`, and:

```sh
npm run ops -- founder bootstrap --email founder@example.com --env production \
  --execute --confirm-production
npm run ops -- deploy worker --env production --execute
npm run ops -- deploy web --branch main --execute
```

Code merges to `main` start one coordinated production chain. Root Markdown,
`docs/`, and the other non-code paths listed in CI skip runtime checks and
production deployment; documentation-only PRs still run path classification. After `.github/workflows/ci.yml`
succeeds, `.github/workflows/deploy-worker.yml` checks out that exact CI commit
and runs `ops deploy worker --env production --execute` (pending remote D1
migrations, then upload). It does not pass `--var`. `TENANT_DATA_PLANE` is
pinned in `[env.production.vars]`, so this path keeps the gate on; only removing
the pin rolls it off (see `docs/founder-cutover.md`).

After the Worker release succeeds, it publishes the released commit SHA for
`.github/workflows/deploy-spa.yml`. The SPA workflow validates and checks out
that SHA, installs both lockfiles with `npm ci`, then runs
`ops deploy web --branch main --execute` to build `web/` and deploy `web/dist`
to the production Pages branch. Both release stages refuse to deploy if `main`
has advanced at the deployment boundary, and one shared non-cancelling lock
serializes Worker and SPA production commands. An older run therefore cannot
overwrite a newer production release. Neither release workflow has a manual
trigger that can bypass the chain.

Before migrations or upload, the Worker workflow runs `ops deploy wipe-check`
after its stale-release check, while holding the production release lock. It
requires zero unfinished D1 records (`wipe_progress.completed_at_ms IS NULL`)
and zero backlog in both `reading-lite-wipe` and `reading-lite-wipe-dlq`.
Stale unfinished records also block: cron can resume them. Completed records
and `users.status = 'deleting'` alone do not block. Failed API calls, missing
queues, missing schema, or invalid responses fail closed and prevent the Worker
release artifact from being published, so the SPA cannot follow that release.
The command can also be run locally with the two Cloudflare environment
variables below; direct `ops deploy worker` invocations do not automatically
run this workflow gate.

For an explicitly selected token-revocation release check, use `ops staging
token-revocation` and `ops deploy release`; see the [operator evidence
workflow](staging-evidence-contract.md#explicit-token-revocation-gate). The wrapper
validates the retained drill before invoking the production wipe check and
existing Worker deploy. It does not change the automatic CI/SPA chain or gate
ordinary `deploy worker` calls.

The queue check uses the [Queues REST metrics endpoint](https://developers.cloudflare.com/api/resources/queues/methods/get_metrics/)
(`backlog_count`, unacknowledged messages), not aggregated analytics. Cloudflare
calls these metrics best-effort. The check is a snapshot: the release lock
serializes deploys but does not stop cron, new wipes, or teardown. A wipe can
start after the check, including during migrations. This is a rollout speed
bump, not an atomic drain/maintenance lock.

If blocked, let the wipe and queues drain, then rerun the failed Worker workflow.
For a reviewed exception, set the GitHub **repository Actions variable**
`DEPLOY_WIPE_OVERRIDE_SHA` to the exact 40-character lowercase commit SHA from
the blocked release, then rerun that workflow. Record the reason in the incident
or issue before overriding. The override skips the wipe reads, including read
failures, and emits a visible warning in the Actions log. It does not bypass CI,
the stale-main check, or the shared release lock. Remove the variable after the
release; even if left set, it cannot bypass the gate for a different commit.
Do not use a generic `true` value. No manual workflow trigger is needed, so the
successful Worker rerun still triggers the existing SPA release chain.

The gate requires D1 Read or Write and Queues Read/Write or Workers Scripts
Read/Write on the production account. The documented deploy token's D1 Edit
and Workers Scripts Edit should cover these APIs, but its actual scopes must
be verified by a successful check; HTTP 401/403 is a blocked release, never
an empty-state result. See [D1 query permissions](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/)
and [queue permissions](https://developers.cloudflare.com/api/resources/queues/methods/list/).

GitHub repository secrets (or the `production` environment):

| Secret | Purpose |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Non-interactive Wrangler. Grant Pages Edit for the SPA workflow. The Worker workflow also needs Workers Scripts Edit, D1 Edit, and zone Workers Routes on **bbell.dev**, **readinglite.ai**, and **readinglite.app** so migrations apply and the route updates succeed (see "readinglite.ai / readinglite.app dual-serve" below). Scope the token to this account and those zones. |
| `CLOUDFLARE_ACCOUNT_ID` | Account Wrangler deploys into. |

The imported founder token expires after 90 days; re-running the same
bootstrap command refreshes `expires_at_ms` and clears a revoked row.

When a release adds an API scope (e.g. `readings:delete`, migration
`0002_readings_delete_scope.sql`), existing tokens do not pick it up on their
own: `ops deploy worker --execute` applies the migration, then re-run the
same founder bootstrap command, its scope grants are idempotent and top up
the existing token.

`ops deploy worker` targets only staging and production (`--env`), so a dev
Worker can never be uploaded by mistake. `ops deploy web --skip-build` reuses
an existing SPA build.

Local `npm run dev` runs `dev:setup` first (local D1 migrations + founder
bootstrap of `dev-local-token`).

The SPA is served from Cloudflare Pages on the same hostname as the Worker;
Worker routes are scoped to `/api/*`, `/health`, and `/mcp*` so Pages handles every other
path. Pages uses `web/public/_redirects` (`/* /index.html 200`) so `/auth/verify`
does not 404. Staging canonical host is `https://staging.readinglite.ai`;
`https://staging.readinglite.app` also serves; `https://reading-lite-staging.bbell.dev`
is retained. The staging SPA is the Pages **preview** deployment created by
`ops deploy web --branch staging` on project `reading-lite` — it is not a
second Pages project. Production canonical host is `https://readinglite.ai`;
`https://readinglite.app` also serves the application; `https://reading-lite.bbell.dev`
is retained as a compatibility and rollback host (see
"readinglite.ai / readinglite.app dual-serve" below). Magic-link mail prefers
the recognized public host the sign-in request arrived on, and falls back to
`WEB_BASE_URL` (`https://staging.readinglite.ai/` on staging,
`https://readinglite.ai/` on production). Digest mail, reading-notification
mail, and MCP `public_url` follow `WEB_BASE_URL`. Browser sessions are
host-scoped (`__Host-` cookie); bearer tokens are host-independent.

### readinglite.ai / readinglite.app dual-serve

Canonical production host is `https://readinglite.ai`. `https://readinglite.app`
is an additional public host. `https://reading-lite.bbell.dev` is retained during
the compatibility/rollback window tracked by issue
[#265](https://github.com/brian-bell/reading-lite/issues/265).

`[env.production.routes]` in `wrangler.toml` carries the same `/api/*`,
`/health`, `/mcp*` trio on all three hostnames (`zone_name = "bbell.dev"`,
`"readinglite.ai"`, and `"readinglite.app"`). All three hit the same Worker
script, R2 bucket, D1 database and Vectorize index. Nothing in the data plane
depends on the hostname, so the `/api/*` read and write paths and `/health` are
interchangeable between them. `/mcp*` is too, `mcpOriginGuard` 403s any
`Origin` outside `MCP_ALLOWED_ORIGINS`. The **code default**
(`DEFAULT_MCP_ALLOWED_ORIGINS` in `src/mcp/origin.ts`, used when the var is
empty) is those three public origins. Production
`[env.production.vars] MCP_ALLOWED_ORIGINS` is configured to the same three
(and the `/api/mcp` alias sits behind the same guard). Non-browser clients send
no `Origin` and work on any of them regardless.

Emitted links are the one place a host is *chosen* rather than observed.
`WEB_BASE_URL` is `https://readinglite.ai/`, so every queue-side link, digest
mail, reading notification mail, MCP `public_url`, points at `readinglite.ai`.
Magic-link mail is the exception: `publicWebBase` prefers the origin the
sign-in request actually arrived on when that origin is a known public host, so
a login started on `reading-lite.bbell.dev`, `readinglite.ai`, or
`readinglite.app` is still mailed back to that host, and only an unrecognised
or spoofed `Host` falls through to `WEB_BASE_URL`. `EMAIL_FROM` stays
`reading-lite@bbell.dev`; moving the sender is a separate later step (S8), kept
apart so a host move and a mail-deliverability change never land together.

Browser sessions are host-scoped, the session cookie is `__Host-`-prefixed and
so carries no `Domain` attribute, so signing in on one host does not sign you
in on another. A one-time re-login on a public host is expected and intended,
not a bug. Bearer tokens are host-independent. The `reading-lite.bbell.dev`
routes stay until that old host is formally retired; they are the rollback
path, and reverting the `WEB_BASE_URL` line plus one deploy is the whole
rollback for the cutover until edge redirects or retirement (C4 / S9) change
that.

`www.readinglite.ai` and `www.readinglite.app` are **not** Worker routes, and
must not become one. `www` → apex belongs to a Cloudflare Redirect Rule (301),
which fires before a request ever reaches the Worker. Nothing in this repo
configures the `www` records or redirect rules.

#### Verified deployment state vs configuration intent

Repo configuration (S1–S4 in `wrangler.toml` and code) is not the same as live
DNS, Pages custom-domain binds, token scope, edge redirects, or MCP client
registrations. Verify those settings against the recorded deployment evidence before
changing domains or credentials.

Recorded on [#265](https://github.com/brian-bell/reading-lite/issues/265) after
S4 ([#276](https://github.com/brian-bell/reading-lite/pull/276), squash-merged
as `3633e5b8` on 2026-09-05): production CI plus Deploy production worker and
Deploy production SPA succeeded on that commit; unauth dual-serve smoke
confirmed `/health` → `ok` and MCP Origin allowlist behavior on all three
hosts; Pages SPA shells on `readinglite.ai` and `readinglite.app` matched
`reading-lite.bbell.dev`. That is the evidence this runbook cites. It is not
evidence this docs sweep re-ran those checks.

Still **not** claimed here, and still open on #265:

- **S3** host-aware magic-link mail is in code; a real mail round-trip from
  each host has not been recorded.
- **C3** re-register Cursor and Grok Bot MCP connectors at `readinglite.ai`.
- **C4** old-host SPA-path redirect and noindex/canonical policy (API and MCP
  traffic must stay unredirected during overlap).
- Optional `www` → apex DNS and Redirect Rules (not in this repo).
- Authenticated `/api/whoami` parity and emitted digest/notification URL
  checks.
- **S7** staging public host; **S8** `EMAIL_FROM` move; **S9** old-host
  retirement.

#### Captain-only DNS / Pages / token (re-verify if zones or tokens change)

This repo publishes Worker routes and origin allowlists. It does **not** flip
live DNS, bind Pages custom domains, or re-scope the Cloudflare API token.
Those steps stay captain-only. Live serving after #276 implies they were
satisfied for the 2026-09-05 cutover; re-check them only if tokens or zones
change. The failure modes below still apply to a future deploy that adds or
removes routes.

1. **Zones on this account.** Confirm the `readinglite.ai` and
   `readinglite.app` zones exist under the same Cloudflare account as
   `CLOUDFLARE_ACCOUNT_ID`. A zone registered under a different account fails
   the same way as a missing zone grant.
2. **Token scope.** `CLOUDFLARE_API_TOKEN` (GitHub secret and any local ops
   token) must include zone Workers Routes on **both** `readinglite.ai` and
   `readinglite.app`, keeping `bbell.dev`. **Until it does, `ops deploy worker
   --env production` applies the remote D1 migrations, uploads the script, and
   then fails on the route publish**, the same route-publication failure described under "MCP
   connector" below, now on two additional zones. It surfaces two ways
   depending on what the token holds: with Zone Read but no Workers Routes
   edit, authentication error 10000 on `/zones/.../workers/routes`; with no
   grant on the zone at all (the likely state for a newly added zone) the zone
   lookup returns nothing and wrangler fails with `Could not find zone for
   readinglite.ai` (or `readinglite.app`). That lookup is filtered by
   `CLOUDFLARE_ACCOUNT_ID`, so a zone registered under a *different* Cloudflare
   account fails with the same message even on a correctly scoped token, check
   the account before chasing scopes. A third variant has nothing to do with
   the token: if one of these patterns is already bound to a different Worker
   in that zone, the publish fails with `Can't deploy routes that are assigned
   to another worker`. Mind what any of them leaves behind: the migrations and
   the new Worker script **have** landed and are live on the existing
   `reading-lite.bbell.dev` routes; only the route addition fails. And because
   `deploy-worker.yml` then exits non-zero, `deploy-spa.yml`, which runs only
   on a successful Worker run, never deploys, so production Worker code sits
   ahead of the production SPA until someone notices. Recovering by re-running
   the failed workflow works only while `main` is still at that commit: both
   deploy workflows re-check `origin/main` against the run's `head_sha` and
   refuse a stale release, so once another merge lands, let the newer commit's
   chain deploy instead. Note the same token scoping bites at retirement, in
   the other direction: on a zone-scoped token wrangler uses the per-zone route
   API, which only adds routes and never deletes stale ones, so **removing the
   `bbell.dev` routes from this file will not remove them from Cloudflare**, delete them in the dashboard when the old host is retired.
3. **Pages custom domains.** Bind `readinglite.ai` and `readinglite.app` as
   Pages custom domains on project `reading-lite`, to the `main` branch, with
   Active certificates. This is an ordering prerequisite, not a cosmetic one:
   a Worker route only receives traffic for a hostname that has a proxied DNS
   record in the zone, and the Pages custom-domain binding is what creates that
   record at the apex. Without a proxied record the routes are simply inert
   and the new host serves neither SPA nor API. Note the flip side: if an apex
   is ever proxied to something else first (a parked page, another site or
   Worker), these routes take `/api/*`, `/health` and `/mcp*` on that hostname
   from the next production deploy, before any deliberate cutover. Check each
   apex before deploying if that may have changed.
4. **`www` → apex (optional).** `www.readinglite.ai` and `www.readinglite.app`
   each need a proxied record plus a `www` → apex Redirect Rule if `www` is to
   resolve at all. Nothing in this repo configures either, and no Worker route
   should: the 301 is meant to happen ahead of the Worker.

#### Migration status

Issue [#265](https://github.com/brian-bell/reading-lite/issues/265) tracks the
move.

In the repo (code, `wrangler.toml`, and current-facing docs):

- **S1**, production Worker routes for `reading-lite.bbell.dev`,
  `readinglite.ai`, and `readinglite.app` (`[env.production.routes]`).
- **S2**, `MCP_ALLOWED_ORIGINS` and `PUBLIC_WEB_ORIGINS` accept those three
  hosts. The code default when the var is empty is the same three.
- **S3**, magic-link mail prefers the request's own public host (code; mail
  round-trip unverified).
- **S4**, cutover: `WEB_BASE_URL` is `https://readinglite.ai/`.
- **S5**, operator script and skill defaults use `https://readinglite.ai`
  (`DEFAULT_API_BASE`; #300 / [#311](https://github.com/brian-bell/reading-lite/pull/311)).
- **S6**, current-facing docs and OpenAPI present `readinglite.ai` as
  canonical (#301).

Recorded live on #265 (2026-09-05), not re-verified by this docs sweep: C0
zone confirmation, C1 token scope, C2 Pages/DNS, S1 routes, S2 MCP origins,
S4 canonical `WEB_BASE_URL`.

Host-behavior checks (code-level; do not mail a live user for S3):

1. `GET /api/whoami` returns the same `tenant_id` on the hosts that actually
   serve, the data plane does not branch on hostname and must not start to.
2. A sign-in request resolves its base to the host it arrived on: from
   `readinglite.ai` the mailed link is `https://readinglite.ai/auth/verify#…`,
   from `readinglite.app` it is that host's own `/auth/verify`, and from
   `reading-lite.bbell.dev` it is that host's own `/auth/verify`
   (`publicWebBase`, `src/control-plane/magic-link-mail.ts`).
3. The old host still serves the SPA and `/api/*` unchanged, it is the
   rollback path and nothing in the cutover removes it.

Still open, in order: **S3** verification; **C3** re-register the MCP
connectors (Cursor, Grok Bot) at `readinglite.ai`; **C4** add the old host's
SPA-path redirect rule and `noindex` header; **S7** staging's own public-host
subdomain; **S8** the `EMAIL_FROM` move; **S9** retiring the old host.

#### Intentional old-host references

A search of the repo after this sweep found **no** remaining `bbookmarks.com`
references (that abandoned target was replaced in #276). Remaining
`reading-lite.bbell.dev` mentions are intentional:

- Compatibility/rollback: production Worker routes, `PUBLIC_WEB_ORIGINS`,
  production `MCP_ALLOWED_ORIGINS`, this dual-serve runbook, rollback
  instructions.
- Historical evidence: `docs/founder-cutover.md` (2026-08-31 tenant cutover
  when production served only this host).
- Original ADR wording in `docs/decisions/0001-tenant-control-plane.md`
  (annotated, not rewritten).
- Local/dev `wrangler.toml` `[vars] MCP_ALLOWED_ORIGINS`, tests, and fixtures
  that use the old host as one allowed origin.

### MCP connector

`POST /mcp` is a Streamable HTTP MCP endpoint on the Worker. Cursor and Grok Bot
add it as a remote connector with a static `Authorization: Bearer <token>`
header (the same token as `reading-lite.bearerToken` / founder bootstrap).
There is no OAuth. Tools call the existing `/api/readings*` routes internally;
the token is never echoed in tool results. Canonical production URL is
`https://readinglite.ai/mcp`. Re-registering connectors that still point at the
old host is C3 on #265 and is not performed here.

Production dual-serves dedicated `mcp*` Worker routes on `readinglite.ai`,
`readinglite.app`, and `reading-lite.bbell.dev` so Pages does not serve SPA
HTML at `/mcp`. Attaching those routes requires zone Workers Routes permission
on the Cloudflare API token; if `ops deploy worker --env production` uploads
the script but fails with authentication error 10000 on
`/zones/.../workers/routes`, add the missing route in the dashboard (Worker
`reading-lite`, matching `hostname/mcp*` pattern) or use the `/api/mcp` alias
which is already covered by `/api/*`. Staging has the same trio of Worker
routes on `staging.readinglite.ai`, `staging.readinglite.app`, and
`reading-lite-staging.bbell.dev` (`/api/*`, `/health`, `/mcp*`).

`MCP_ALLOWED_ORIGINS` is the Origin allowlist. The code default
(`DEFAULT_MCP_ALLOWED_ORIGINS` in `src/mcp/origin.ts`, used when the var is
empty) is `https://reading-lite.bbell.dev`, `https://readinglite.ai`, and
`https://readinglite.app`. Production `[env.production.vars]` is configured to
those three. Local `wrangler.toml` `[vars]` currently sets only
`https://reading-lite.bbell.dev`; staging sets
`https://reading-lite-staging.bbell.dev`, `https://staging.readinglite.ai`, and
`https://staging.readinglite.app`. Requests with no `Origin` pass
(non-browser clients). Unknown Origins are 403.

Smoke the handshake after a worker deploy:

```sh
TOKEN=$(grep ^READER_API_TOKEN= .stg.vars | cut -d= -f2-)
curl -sS https://reading-lite-staging.bellbm.workers.dev/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

### Staging lifecycle

Staging exists for real end-to-end smoke tests that need Queue, R2, and
Vectorize without mutating the production corpus. Both lifecycle scripts are
hard-coded to staging resource names, refuse production-looking names, and are
idempotent, "already exists" on setup and "already gone" on teardown are
treated as success, while unexpected Wrangler or R2 API failures stop the run.

```sh
npm run ops -- staging setup --execute
npm run ops -- staging teardown --execute
```

Teardown removes Queue consumers before deleting the Worker, then deletes the
reading, digest, and wipe Queue/DLQ pairs and Vectorize index, deletes staging D1, empties the bucket via
the S3-compatible R2 API, and deletes the bucket. The bucket-empty step needs
the `CORPUS_R2_*` credentials above. Setup creates the same three queue families. See the command help for the
complete resource plan.

Smoke-test idempotent submits against staging:

```sh
VARS_FILE=.stg.vars BASE=https://reading-lite-staging.<workers-subdomain>.workers.dev \
  ./scripts/manual/idempotency-smoke.sh a "https://example.com/reading-lite-staging-$RANDOM"
```

Clean up the throwaways afterwards, including `ready` ones. Staging pins
`TENANT_DATA_PLANE = "1"` (see the next section), so the live layout is the
staging founder tenant, not `global`. Resolve `$STG_TENANT` from staging's
`GET /api/whoami` the same way production's `$TENANT` is resolved:

```sh
npm run ops -- corpus audit --tenant "$STG_TENANT" --bucket reading-lite-staging --execute
npm run ops -- corpus drop --tenant "$STG_TENANT" "https://example.com/reading-lite-staging-123" \
  --bucket reading-lite-staging --allow-ready \
  --vectorize reading-lite-staging --execute
```

`--tenant global` still addresses staging's retained pre-tenant copy, which the
gate makes invisible to the Worker. Use it only when you mean that copy.

### Rehearsing account deletion on staging

S5 proof step (run only in the separately approved live drill): capture
`ops account residue-scan --tenant "$DRILL" --bucket reading-lite-staging`
after wipe completion and again after cron teardown. Check per-source JSON,
first-completion history, and the explicit unknown section; exit 1 is expected
while DO/address-history visibility remains incomplete. Before arming the wipe,
audit/repair synthetic bare/composed pairs using the S5 sequence above, including
a protected unnamespaced control. Keep that control intact. The separately executed
[2026-09-05 staging drill](evidence/195-staging-drill-2026-09-05.md) records
the live repair, deletion, and automatic teardown evidence, including the
final `residue:false, incomplete:true` scan and remaining acceptance limits.
Signup-shaped email reuse after teardown is recorded in the
[2026-09-05 staging email-reuse drill](evidence/286-staging-email-reuse-2026-09-05.md)
and its [second-run supplement](evidence/286-staging-email-reuse-followup-2026-09-05.md).
The accepted #286 evidence retains `incomplete:true`; broader deletion coverage
and the named limits were subsequently accepted under #288/#195. #285 legacy
cleanup remains explicitly deferred; this runbook does not require another
acceptance drill merely because a routine release occurs.


`src/account-wipe.ts` skips with `no_tenant_prefix` whenever `TENANT_DATA_PLANE`
is off, so an environment with the gate unset cannot exercise the destructive
path at all. Staging therefore pins the gate in `[env.staging.vars]`, and its
pre-tenant corpus was migrated under `u/{founderTenantId}/` by
the now-retired founder migration command. It copied rather than moved, so
the legacy `readings/` and `index/` objects remain in the bucket.
Removing the pin is a **complete rollback only before post-pin writes resume**.
After the pin, every new staging reading is written only under its tenant R2
root and Vectorize namespace. Rolling the gate back then makes the Worker read
the retained global snapshot: the copy-not-move pre-tenant corpus is visible
again, and only post-pin writes are hidden (their bytes still exist under
`u/{tenantId}/`). After writes have landed, rollback requires a freeze plus
reverse reconciliation (copy tenant-rooted objects and namespaced vectors back
to the global layout) or an explicit captain-accepted loss of the post-pin
corpus.

One consequence of that to keep in view if the drill is ever pointed at the
staging *founder* rather than a throwaway tenant: the wipe never touches the
pre-tenant `readings/` / `index/` objects or bare-id vectors, so a full
duplicate of the staging corpus survives outside every tenant root. "Nothing
left under `u/{tenantId}/`" would then not mean the data is gone from staging.
It is the same hole production carries until the legacy objects are deleted
under sign-off.

**Preflight, before the deploy that turns the gate on.** While the gate is off,
fan-out short-circuits with `no_tenant_prefix`, so any account left in
`status='deleting'` by earlier testing has been accumulating harmlessly. The
moment the pin ships, the next `*/15` cron enqueues a *real* wipe for every one
of them whose 7-day grace has elapsed. Look before you deploy:

```sh
npx wrangler d1 execute CONTROL_PLANE --env staging --remote \
  --command "SELECT u.id, u.email_canonical, u.status, u.deleting_at_ms FROM users u \
             LEFT JOIN wipe_progress w ON w.tenant_id = u.id \
             WHERE u.status <> 'active' AND w.completed_at_ms IS NULL"
```

The join is what makes this list *actionable* rather than just true. A tenant
whose `wipe_progress` row carries a `completed_at_ms` has already been wiped.
Before S4 that meant fan-out skipped it; **after S4 it means the next tick
will hard-delete the account**, every such tenant, with no exemption. The
`IS NULL` still covers a *reopened* wipe (a reopen clears `completed_at_ms`),
which is still live and does belong in the list. Completed empty-prefix tenants
are a separate question:

```sh
npx wrangler d1 execute CONTROL_PLANE --env staging --remote \
  --command "SELECT u.id, u.email_canonical, w.completed_at_ms, w.force \
             FROM users u JOIN wipe_progress w ON w.tenant_id = u.id \
             WHERE u.status = 'deleting' AND w.completed_at_ms IS NOT NULL"
```

Completed fixtures follow the same teardown path; do not assume an old
fixture still exists. The dated evidence below records the original S6 fixture.

Any account in either preflight result that is not meant to be destroyed, the staging founder above all, needs an operator recovery decision before
the deploy. The reset below is only for a deletion that has not destroyed data.
Restoring `status='active'` alone
is not enough: leave `deleting_at_ms` set and a later `DELETE /api/account`
reuses it via `COALESCE(deleting_at_ms, ?)` in `beginAccountDeletion`, so the
next cron can wipe immediately and skip the 7-day grace. An unfinished or
reopened `wipe_progress` row (`completed_at_ms` NULL) is worse: fan-out treats
it as a **resume**, and resume ignores grace. After a later delete the next
`*/15` tick enqueues immediately.

A delivery that already passed the status check can continue deleting after
reactivation. **The heartbeat is advisory**: a recent `updated_at_ms` is a
reason to stop, but an old value or waiting 15 minutes does not prove that no
job is active. Delayed retries can outlive that window.

Before any reset:

1. Pause cron fan-out and teardown, new wipe submissions, and queue delivery
   for staging. Confirm previously started wipe/teardown invocations have ended
   and any submitted Vectorize mutations have settled. Turning the tenant gate
   off does not cancel an invocation that already passed it.
2. Account for queued messages, delayed retries, and DLQ redrives for this
   tenant. They must not survive the reset and a later deletion request: an old
   `force: true` envelope would bypass the new grace period. Do not drain them
   by running the destructive consumer against an account being rescued.
3. Inspect and save the progress record, audit record, ledger, and remaining
   R2/Vectorize state. If deletion has begun, the account was previously wiped,
   teardown was attempted, or any of those facts cannot be established, stop
   this reset and prepare a data-recovery plan. Zero counters alone do not
   prove nothing was deleted. This SQL cannot restore deleted data or preserve
   the confirmation state of a partially completed wipe.

There is no atomic cancel-and-rescue command. If the pause and pending-message
conditions cannot be verified, do not run the writes below. With them verified,
a never-completed, unintended deletion can be reset as follows. A completed or
reopened wipe's first-completion history must remain intact; the guards refuse
that case rather than erasing it.

```sh
npx wrangler d1 execute CONTROL_PLANE --env staging --remote \
  --command "SELECT * FROM wipe_progress WHERE tenant_id='<tenant>'"
npx wrangler d1 execute CONTROL_PLANE --env staging --remote \
  --command "SELECT * FROM account_deletions WHERE tenant_id='<tenant>'"
# Only after the pause, pending-message, and data checks above:
npx wrangler d1 execute CONTROL_PLANE --env staging --remote \
  --command "UPDATE users SET status='active', deleting_at_ms=NULL, updated_at_ms=<now> \
             WHERE id='<tenant>' AND status='deleting' \
             AND NOT EXISTS (SELECT 1 FROM account_deletions WHERE tenant_id='<tenant>') \
             AND NOT EXISTS (SELECT 1 FROM wipe_progress WHERE tenant_id='<tenant>' \
               AND (completed_at_ms IS NOT NULL OR first_completed_at_ms IS NOT NULL))"
# Stop unless the UPDATE reports changes: 1. Then remove the stale resume state:
npx wrangler d1 execute CONTROL_PLANE --env staging --remote \
  --command "DELETE FROM wipe_progress WHERE tenant_id='<tenant>' \
             AND completed_at_ms IS NULL AND first_completed_at_ms IS NULL \
             AND EXISTS (SELECT 1 FROM users WHERE id='<tenant>' \
               AND status='active' AND deleting_at_ms IS NULL)"
```

Re-read the user and progress rows before resuming: the user must be active,
`deleting_at_ms` NULL, and the unfinished progress row absent. Keep the ledger;
this reset does not authorize changing its deletion or confirmation records.

That still is **not** a full rescue: `beginAccountDeletion` stamped
`revoked_at_ms` on every session and API token and nothing reverses that, so
the account is `active` but cannot authenticate. Re-run
`ops founder bootstrap --env staging --execute` for the founder, or issue a
fresh magic link, before assuming staging works again.

Staging already has tenant mode enabled and its founder cutover is complete.
Do not rerun that migration to rehearse deletion. For a rebuilt environment,
verify restored tenant data (or that the environment is intentionally empty)
and follow the [tenant-mode activation guard](#tenant-mode-activation-guard).
The historical migration procedure and evidence remain in
[the completed cutover record](founder-cutover.md).

The drill itself. Seed a throwaway tenant, fence it, let cron wipe it, then
prove the residue is gone.

Two id rules, both of which produce a rehearsal that looks perfect and proves
nothing if you get them wrong:

- **`$DRILL` is a fresh `usr_<uuid4>`, and it must be lowercase.**
  `parseTenantId` canonicalizes to lowercase (`src/control-plane/ids.ts`), but
  macOS `uuidgen` emits uppercase. An uppercase id still fans out, and then the
  wipe addresses `u/{lowercased}/` and writes `wipe_progress.tenant_id`
  lowercase, so the objects you seeded and every `WHERE tenant_id='$DRILL'`
  query below quietly miss.
- **Reading ids must use the Crockford alphabet `parseReadingId` accepts**
  (`src/services.ts` `ID_ALPHABET`, no `I`, `L`, `O`, `U`). An id outside it is
  skipped by `ops corpus seed-vector-ledger`'s walk, so the objects phase still
  deletes the reading's R2 objects but no ledger row and no `deleteByIds` ever
  exist for it. The vector is stranded, and surfaces at the end as residue, a
  synthetic reproduction of the issue #261 gap rather than a wipe bug.
- **You do not need to seed the drill ledger.** The wipe seeds its own ledger
  from the objects you write, before it deletes anything, so a drill that skips
  seeding is testing the real path rather than a rigged one. Watch for
  `account_wipe_ledger_seeded` with `rows_created` equal to the number of
  readings you seeded, that line is the wipe proving it found them.
- **Expect two wipe passes for a healthy tenant.** The first seeds and submits
  the deletes; the confirmation is not allowed to count an absence until 120s
  after `deleteByIds` returned, because propagation was measured at 30-90s and
  a probe inside that window carries no information. If no delayed confirmation was needed, inspect ledger state and delete
  submissions before treating that as evidence of a nonempty wipe.

```sh
# 1. Create the account. Either sign up on staging for real, or insert the row
#    directly. The wipe is driven off this row: without it the UPDATE below
#    matches nothing, listDeletingUsers never returns the tenant, and the whole
#    drill silently exercises nothing while every residue check passes.
#
#    Use a per-run address. `users.email_canonical` is NOT NULL UNIQUE, and the
#    original S6 fixture below already holds `s6-drill@test.example` until its
#    teardown removes the row — reusing it fails this INSERT on the constraint,
#    which is exactly the "creates nothing, passes everything" outcome the
#    warning above is about.
npx wrangler d1 execute CONTROL_PLANE --env staging --remote \
  --command "INSERT INTO users (id, email_canonical, email_display, status, \
             email_verified_at_ms, created_at_ms, updated_at_ms) \
             VALUES ('$DRILL','s6-drill-$DRILL@test.example', \
             's6-drill-$DRILL@test.example','active',<now>,<now>,<now>)"

# 2. Seed. Objects under u/$DRILL/ (manifest.json, index/by-id/, index/by-url/,
#    index/list.json) plus one namespaced vector {$DRILL}:{readingId} per ready
#    reading. Copying manifests and embeddings out of the staging founder corpus
#    keeps the shapes real and spends nothing on providers.
# 3. Confirm the vectors are live in the namespace before deleting anything —
#    an upsert takes up to ~45s to become visible.
# 4. Fence the account so the ordinary */15 cron starts the wipe.
#
# Direct-insert path (step 1): this tenant has no sessions or tokens, so the
# users-row UPDATE is the whole fence:
npx wrangler d1 execute CONTROL_PLANE --env staging --remote \
  --command "UPDATE users SET status='deleting', deleting_at_ms=<now - 8 days>, \
             updated_at_ms=<now> WHERE id='$DRILL' AND status='active'"
```

**Do not use that users-only UPDATE for a tenant that signed up for real.** It
is not `beginAccountDeletion`: `src/control-plane/account-delete.ts` also
revokes every session and API token. Skip the revoke and the later
`live_sessions = 0` / `live_tokens = 0` check fails, and the drill never
exercises the credential fence.

Prefer the real API (session cookie, `X-CSRF-Token`, recent-auth window, the SPA Security page is the same path), then backdate grace so cron, not a
hand-injected queue message, starts the wipe:

```sh
# After DELETE /api/account with body { "confirm": "delete" }:
npx wrangler d1 execute CONTROL_PLANE --env staging --remote \
  --command "UPDATE users SET deleting_at_ms=<now - 8 days>, updated_at_ms=<now> \
             WHERE id='$DRILL' AND status='deleting'"
```

If you cannot call the API, this is the SQL that mirrors `beginAccountDeletion`
(status write, then the two revokes, `ACCOUNT_DELETE_REVOCATION_REASON` is
`account_delete`). Use it **instead of** the users-only UPDATE, not after it:

```sh
npx wrangler d1 execute CONTROL_PLANE --env staging --remote \
  --command "UPDATE users SET status='deleting', deleting_at_ms=<now - 8 days>, \
             updated_at_ms=<now> WHERE id='$DRILL' AND status='active'"
npx wrangler d1 execute CONTROL_PLANE --env staging --remote \
  --command "UPDATE sessions SET revoked_at_ms=<now>, revocation_reason='account_delete' \
             WHERE user_id='$DRILL' AND revoked_at_ms IS NULL"
npx wrangler d1 execute CONTROL_PLANE --env staging --remote \
  --command "UPDATE api_tokens SET revoked_at_ms=<now> \
             WHERE user_id='$DRILL' AND revoked_at_ms IS NULL"
```

**Check that the users-row fence UPDATE reported `changes: 1`.** That is the
status/backdate write (`SET status='deleting'` on the direct-insert path, or
`SET deleting_at_ms=…` after `DELETE /api/account`). Zero there means the row
is missing or not in the expected status, and everything downstream will look
like a clean, successful wipe of nothing. The sessions and `api_tokens`
revokes may report `changes: 0` (direct-insert, no credentials) or `N`
(signed-up); that is not the fence check.

Backdating `deleting_at_ms` past the 7-day grace is what lets the ordinary
`*/15` cron fan-out start the wipe, so the drill exercises the real entry point
instead of a hand-injected queue message. Then watch it finish:

```sh
npx wrangler d1 execute CONTROL_PLANE --env staging --remote \
  --command "SELECT * FROM wipe_progress WHERE tenant_id='$DRILL'"
```

Expect a deferral after new delete submissions. Confirmation cannot count until
120 seconds after submission, then follows the 120/240/480-second backoff and
four-attempt bound described under [confirmation](#progress-seeding-and-confirmation).
A clean probe can complete immediately when there are no submitted rows requiring
the initial delay. Do not judge a wipe by its number of deliveries alone.

`probe_saw_residue=1` can record normal propagation even when the final wipe is
clean. `residue=1` means the bounded wipe completed without confirmation and
needs investigation. Read both fields and retain actual probe errors; a failed
read is not proof that vectors are present or absent.

Residue checks afterwards.

**1. R2 under the tenant root, expect zero objects.** Do **not** use
`corpus audit` for this: it reads `index/list.json` first and hard-errors
("could not read index/list.json") when the object is missing, which is exactly
the state a successful wipe leaves behind. List the prefix directly instead,
with the repo's own R2 client rather than a hand-rolled `aws` invocation, `r2InventoryClientFromVars` (`scripts/lib/cf-clients.ts`) is what
`ops account sweep-wipe-prefix` already uses, and it reads the same
`CORPUS_R2_*` / `CLOUDFLARE_API_TOKEN` values from the environment or
`.corpus.vars` that the rest of this runbook assumes:

```ts
// r2ls.ts, run from the repo root with `DRILL=usr_… npx tsx ./r2ls.ts`
import { loadDotVars } from "./scripts/lib/dotvars";
import { r2InventoryClientFromVars } from "./scripts/lib/cf-clients";

const vars = { ...loadDotVars(".corpus.vars"), ...process.env };
const client = r2InventoryClientFromVars(vars, "reading-lite-staging");
const objects = await client.listObjects(`u/${process.env.DRILL}/`);
for (const o of objects) console.log(o.key, o.size);
console.log("objects:", objects.length);
```

**2. Orphaned R2 wipe progress** (superseded by D1 in slice S2), expect
0 objects:

```sh
npm run ops -- account sweep-wipe-prefix --bucket reading-lite-staging
```

3. **Vectorize**, a namespaced query against the tenant namespace must return
   no matches. That is the same signal `SimilarityStore.probeNamespace()` uses.
   Do not use whole-index `describe()` counts as evidence: they are served from
   replicas at different processing frontiers and go backwards, so `vectorCount`
   and `processedUpToMutation` both flap between values while the underlying
   per-id reads are correct.

4. **D1 after the wipe, before teardown**, the wipe still removes the
   **data plane only**. Until control-plane teardown runs, the `users` row,
   the `wipe_progress` completion record, and the tenant's `sessions`,
   `api_tokens`, `user_settings` and `digest_deliveries` rows all survive:
   `beginAccountDeletion` *revokes* sessions and tokens by stamping
   `revoked_at_ms` in place rather than deleting them, and `user_settings` is
   never touched by the wipe. Check that credentials are **revoked**, not
   that rows are absent:

```sh
npx wrangler d1 execute CONTROL_PLANE --env staging --remote \
  --command "SELECT (SELECT COUNT(*) FROM sessions WHERE user_id='$DRILL' AND revoked_at_ms IS NULL) live_sessions, \
             (SELECT COUNT(*) FROM api_tokens WHERE user_id='$DRILL' AND revoked_at_ms IS NULL) live_tokens, \
             (SELECT completed_at_ms FROM wipe_progress WHERE tenant_id='$DRILL') completed_at_ms, \
             (SELECT residue FROM wipe_progress WHERE tenant_id='$DRILL') residue"
```

Expect `live_sessions = 0`, `live_tokens = 0`, a non-NULL `completed_at_ms`, and
`residue = 0`. A tenant seeded directly (rather than signed up for) will simply
have no rows in those tables at all, which is not evidence either way.

**Control-plane teardown is automatic (S4).** Once the wipe has completed and
the prefix is empty, the next `*/15` cron tick runs
`src/control-plane/account-teardown.ts`: audit row first, Durable Object guards
fail-closed, address-history lookup, R2 prefix recheck immediately before the
batch, then one ordered D1 delete ending at `users`. Do **not** manually
`DELETE FROM wipe_progress` / `DELETE FROM users`, that bypasses the audit
row, the guard purge, and the prefix recheck, and it is exactly the sequence
teardown already performs. After teardown the same queries should show the
`users` and `wipe_progress` rows gone and a single `account_deletions` row for
the tenant. The address is then free; under `invite_only` it still needs a
fresh invite. Signup challenges are associated through `completed_user_id`
when `user_id` is NULL; the automatic teardown handles both ownership columns.
D1 enforces foreign keys by default, so child-before-parent ordering matters;
do not restore the old manual SQL based on the opposite assumption.

A new throwaway drill tenant is torn down on the tick after its wipe
completes. Watch `account_teardown_complete` for it, then confirm the audit
row and the absent `users` row rather than deleting them by hand.

The historical S6 fixture, `usr_5e6d0000-0000-4000-8000-000000000006`,
also followed automatic teardown. The [staging evidence](evidence/195-staging-drill-2026-09-05.md)
records its removal and preserved first-completion history. Do not reuse it as
an assumed live fixture; create a fresh throwaway tenant for a new drill.

Do not restore the former source-level exemption for that ID. It had no
environment gate, so it also exempted the ID in production, and its release
condition reused `wipe_progress.force`. An unrelated redrive could therefore
release the supposed hold. Protect test data through operator coordination,
never a tenant-ID exception in the deletion code.

## Diagnosing a single reading

`GET /api/readings/:id/diagnostics` shows whether the by-id and by-url pointers
line up, which R2 objects exist, the list-index row, and the recent attempt
records, including which stage failed (`fetch_source`, `embed_source`,
`summarize`, `upsert_vector`, `write_indexes`, …). Each background run stages an
attempt record under `readings/.../attempts/{attempt_id}.json` with the trigger,
stage, timings, and sanitized error details, so failures are inspectable without
`wrangler tail`.

`POST /api/readings/:id/reprocess` retries that exact id. A failed reading
becomes `pending` while the attempt runs. A ready reading keeps its current
manifest as the fallback: a successful attempt replaces the manifest and vector,
and a failed one preserves the ready manifest with
`last_attempt.status = "failed"`.

## Corpus tools

For a complete production refresh window, use the
[full-run procedure](corpus-refresh/runbook.md). The
[September 4, 2026 report](corpus-refresh/2026-09-04-results.md) records the
first complete calibration run, its costs, and the retained thresholds.

| Script | What it does |
|---|---|
| `npm run ops -- corpus audit` | inventory of every non-ready reading, classified by failure reason (plans by default; `--execute` writes `index.json` + `INDEX.md`) |
| `npm run ops -- corpus recover` | acts on an audit: reprocess or re-extract per a per-reason policy table (plans by default; `--execute` submits) |
| `npm run ops -- corpus drop` | remove readings by URL or id (`--allow-ready` also clears the vector) |
| `npm run ops -- corpus sweep` | reconcile duplicate copies of one resource across URL spellings (keeps the best, drops the rest with their vectors) |
| `npm run ops -- corpus backfill-similarity` | fill in `manifest.similarity` for readings written before the field existed (no embedding calls; writes only that field) |
| `npm run ops -- corpus refresh-neighbours` | re-measure readings against Vectorize, print the staleness inventory, and write `refresh-report.json` (no LLM; measures only what changed since the run marker by default, `--full` sweeps every ready reading; `--execute --sole-writer` rewrites drifted snapshots and flushes `index/list.json`) |
| `npm run ops -- corpus refresh-connections` | consume `refresh-report.json`, plan relationship-only judgements with estimated cost, and selectively update connections, novelty, and the computation date |
| `npm run ops -- corpus refresh-tensions` | pair each flagged reading in `refresh-report.json` with its neighbours, pre-filter on overlap evidence, and judge directional tensions written to both manifests (`--pair a,b` hand-picks a pair) |
| `npm run ops -- corpus backfill-vectors` | restore missing Vectorize vectors by re-embedding stored TL;DRs (writes Vectorize, plus the tier-1 run marker it invalidates; R2 is otherwise read-only) |
| `npm run ops -- corpus normalize-tags` | rewrite stored tags into canonical hyphenated form (writes only `manifest.tags`) |
| `npm run ops -- corpus purge-connections` | remove dangling inbound `connections[]` entries for one already-deleted reading id (full scan; plan-first; ETag CAS writes) |
| `npm run ops -- corpus rebuild-list` | rewrite `index/list.json` from live manifests (backfill list-row fields) |
| `npm run ops -- corpus delete-orphans` | remove orphan-duplicate pending readings consistently |
| `npm run ops -- corpus ingest` | bulk-ingest a fresh markdown directory through a provider Batch API |

The `refresh-neighbours`, `refresh-connections`, and `refresh-tensions`
examples below all select the founder tenant. Since the production cutover, new
readings are written under the founder's `usr_…` namespace, so export it once
and reuse it:

```sh
# Fill in, then paste.
export TENANT=usr_…   # production whoami.tenant_id
```

Take that id from an authenticated `GET /api/whoami` against production. The
production founder id is also recorded in the cutover log in
`docs/founder-cutover.md`, but that file lists a **staging** founder id as
well, do not copy the wrong one.

Never run a production refresh with `--tenant global`. That selector still
resolves to the legacy pre-cutover layout, which no longer receives readings;
refreshing it spends judgements on a copy nobody reads.

Production credentials do not live in the repo either. All three refresh
commands read them the same way, and that is where the trap is: `.corpus.vars`
S3 keys are commonly scoped to the staging bucket and then 403 against the
production bucket, and every one of them prefers S3 keys over a Cloudflare API
token whenever both are present, so stale staging keys silently win over an
otherwise correct token. Source production keys from outside the repo; the
credentials row of the cutover log in `docs/founder-cutover.md` records what an
actual production run needed.

`refresh-neighbours` used to be the exception, running every call through a
`wrangler` subprocess and ignoring `CORPUS_R2_*` entirely. It now picks its
storage path automatically: direct when `CORPUS_R2_*` keys or a Cloudflare API
token are present, wrangler otherwise, and it prints which one it took in the
header (`Storage: direct (S3/REST) — CORPUS_R2_* keys`). Direct needs both
halves, an R2 credential for the manifests and a Cloudflare API token for
Vectorize, which has no S3 access-key path, so R2 keys alone stay on wrangler.
`--via wrangler` forces the old path, `--via direct` forces the new one (and
fails with the missing credential rather than falling back), and `--local`
always uses wrangler because nothing else can reach the miniflare bucket. A
direct run also prints the Cloudflare account it resolved (`Account: …`) under
that line: the bucket name alone does not say whose bucket, and the trap above
is precisely a shell that loaded the wrong credential file.
Direct is the reason to prefer it: it removes the ~0.8s of Node start-up the
wrangler path paid on every Vectorize query and every manifest read. Measured on
staging (29 ready readings, plan mode): 46.6s over wrangler against 10.0s
direct, with manifest reads 25.7s → 3.4s and Vectorize queries 19.5s → 6.5s.
Both paths write a byte-identical `refresh-report.json`, and each flushes
`index/list.json` through its own client, so a direct run needs no wrangler auth
at all.

All three refresh commands end every pass, plan or execute, with a `Timing:`
block: one row per phase the pass used (`list read`, `planning reads`, the
manifests read while planning, `manifest read` for reads outside a planning
pass, `vectorize query`, `reverse query`, the scoping queries an incremental
tier-1 pass makes, kept apart from the measurement ones because the scope
trades one for the other, `run marker`, `provider`, `manifest write`,
`list write`),
each with its call count and total wall time, then the run total. The block is
printed even when the pass ends in an error, and failed calls are counted, since
a stalled read is exactly the wall time worth seeing. Execute mode also prints
`ms=` per judgement beside its token usage. Two things the counts do not say:
they count storage calls, not HTTP requests (a `refresh-neighbours` manifest
read is one request on the direct path but a whole wrangler process around one
on the wrangler path, which is most of why the same row times so differently
between them), and a time includes any retry and its backoff, so one unusually
slow call may be a call that quietly retried. Record the block: it is the baseline a later run or a
performance change is compared against, and it is what tells a slow pass apart
from a hung one.

Two robustness limits sit behind those numbers. `refresh-connections` and
`refresh-tensions` reach R2 over the S3 API when `CORPUS_R2_*` keys are set,
and every request on that path carries a 30-second deadline and gets up to
three attempts on a timeout, a network fault, a 5xx, or a 429 (honouring
`Retry-After`), so one transient read no longer ends the run. Conditional
writes are the exception: they get the deadline but are never repeated, because
a retry can see its own landed write and report a lost race that did not
happen. Both commands' judgement calls retry 5xx the same way, and a 429
surfaces as a `RateLimitedError` naming the retry-after the provider asked for, that one is what the execute pass's global backoff reacts to (below).

Those limits are these two commands' policy and nothing else's. The other ops
commands that talk to R2 over the S3 API, `corpus ingest`, `corpus recover`,
`corpus purge-connections`, `staging teardown`, keep
the single attempt and the absent deadline they were written and run against.

`refresh-neighbours` is the one exception, and only in part: it gets the same
deadline and retry for its manifest reads and writes whenever it runs direct
over S3 keys. Everything else is still uncovered. The Cloudflare REST client, the R2 fallback used when only `CLOUDFLARE_API_TOKEN` is set, and every
Vectorize query on the direct path, backs off on 429 but has no deadline and
no 5xx retry; the wrangler subprocesses have neither; and the judgement calls
retry but carry no deadline of their own. A stall on any of them still looks
like a silent pass, the `Timing:` block is what makes it visible.

`ops corpus refresh-neighbours` re-queries Vectorize by the stored vector id of
each ready reading in scope, by default the readings that moved since the run
marker, and under `--full` every one of them, per **Scope** below, with no
embedding calls and no LLM. It prints the staleness inventory,
and always writes its report (`--out`, default `./refresh-report.json`; give
each writer its own path, see below), the input contract for later
judgement slices. The report compares stored connection IDs with the current
floored ready-neighbourhood. It distinguishes missing or non-ready citations
(`stale_connection`), still-ready citations that fell below the floor
(`connection_below_floor`), uncited neighbours created after the last judgement
(`new_neighbour`), and older uncited neighbours that now clear the floor
(`uncited_neighbour`). Realtime ingest and the offline batch write phase persist
the same candidate ID set on a ready manifest (`readyManifest`), including
candidates the summarizer did not cite, so the first neighbour refresh already
has a baseline. A later successful relationship-only judgement rewrites that
set. Later refreshes compare that stored set with the current floored
ready IDs in both directions, so a rejected candidate is not billed again while
the same candidate set remains. A newly present older candidate receives
`uncited_neighbour`; so does a previously considered uncited candidate that
later falls below the floor or becomes non-ready. This baseline tracks ID
membership; reprocessing the same candidate ID is not a membership change. The
producer preserves live ingestion's selection order: raw
Vectorize top five, similarity floor, then ready-ID intersection. It does not
fill vacated slots with lower-ranked ready readings. Plan mode does not mutate
R2. `--execute` rewrites only
drifted `manifest.similarity` snapshots (count change or `|Δmax|`/`|Δmean|`
≥ 0.02) and then flushes `index/list.json` by merging only the `similarity`
field of the rows it measured onto the live index, so a row added or rewritten
while the pass ran is no longer reverted. On the direct path that merge is an
`If-Match` compare-and-set retried with jittered backoff; on the wrangler
fallback, which has no conditional put, the read→put window is unguarded. So
`--execute` is refused without `--sole-writer`: do not run it while
submissions are in flight. Leaves status, vectors, title, tldr, tags, keywords,
entities, and `summary_markdown` untouched. A second immediate `--execute`
writes nothing.

```sh
# The corpus-wide staleness inventory this section describes needs --full: a
# bare invocation is scoped to what moved since the run marker (see Scope), so
# on a quiet night it measures nothing and exits 0.
#
# --out keeps an ad-hoc sweep off BOTH schedules' report paths — the nightly's
# and the weekly's. See "different --out paths" below for why no two writers
# may share one.
npm run ops -- corpus refresh-neighbours --tenant "$TENANT" --full \
  --out ./refresh-report-adhoc.json
npm run ops -- corpus refresh-neighbours --tenant "$TENANT" \
  --full --execute --sole-writer --out ./refresh-report-adhoc.json
```

**Scope.** By default the pass measures only what moved (`--since-last-run`,
which is now the default and stays accepted as a way of saying so out loud).
`--full` is the explicit sweep: every ready reading, O(N) whatever changed, the immediate rerun in run A measured 553 readings in 16 minutes and wrote none
of them. (That 16 minutes is the wrangler path; the same sweep on the now-default
direct path models at ~3.5–4 min, see the staging proof below. The argument for
the narrowed scope does not rest on the slower figure.) The default measures only the
readings whose neighbourhood could have moved since the run marker stored at
`index/refresh-state.json` (per tenant): those created or reprocessed since it,
and the reverse neighbourhood of each changed vector (one topK-100
metadata-less query per changed reading, keeping matches
at or above the similarity floor less 0.1, so a reading that far away cannot
gain or lose a floored neighbour because that one vector changed). The reverse
query is the only source of strangers: `index/list.json` rows carry no
citations, so a reading that cites a changed one is found because it still
scores above the bound, which holds for every change except a vector that
moves. The scope and its reason are printed
(`Scope: incremental (12 reading(s)) — …`) and recorded in the report header.

It escalates to a full sweep whenever that reasoning runs out: no marker (the
first run, a deleted one, or one written before this check existed, the marker
is version 2 and a version-1 marker is rejected with a message that says so), a
marker invalidated by `corpus backfill-vectors`, a reading the marker recorded
that has since left the list (a purge names nothing a timestamp can find), a
failed reverse query, a changed *ready*
reading with no vector to scope from, or a reverse neighbourhood that came back
full at topK with no match below the bound, meaning the query was truncated and
the real set is unknown, never a narrower pass. A short result is a complete
one, so an isolated reading, whose only match is itself, does not escalate. An
escalation reports how many of the changed readings caused it and names the
first, because a corpus that saturates most nights is buying nothing from the
narrowed scope, that rate is the number to watch, and a corpus that escalates
every night should be run as `--full` outright rather than paying the reverse
queries first.

An incremental report is a statement about its scope, not about the corpus: a
persistent flag on a reading nobody touched, the backfill's 394
`connection_below_floor` rows, say, stays invisible until that reading enters
scope. **The weekly `--full` sweep is what makes the default safe, and it is
scheduled by the operator, outside this repository**, nothing in git schedules
a corpus refresh pass (the `crons` triggers in `wrangler.toml` drive the
Worker's own scheduled handler, not these commands), so see "Refresh exit codes"
for the wrapper an operator's cron wants. If
nothing sweeps, those persistent flags never resurface and the served
`similarity` numbers drift indefinitely.

A reading the scope does bring in is measured like any other target, so its
`similarity` snapshot and its list row are brought current in the same pass, nothing about being in scope defers a measurement to the sweep.

**What an incremental pass keeps exact, and what it only keeps approximate.**
Flags are exact: the bound is derived so that a reading further away than it
cannot gain or lose a *floored* neighbour because one vector changed. The
stored `similarity` snapshot is not, and this is broader than the moved-vector
case above. That snapshot, and the `index/list.json` row the API and the SPA
serve, summarises the **raw** topK, sub-floor scores included, so a vector
merely *added* anywhere enters some stranger's topK and moves its `max`/`mean`
at any score, far below the bound. Between sweeps those numbers are therefore
approximate on every reading the scope left out. The drift is deterministic and
the next `--full` clears it.

The moved-vector case remains the one thing that defers a *re-judgement* rather
than a number: a reprocess that moves a vector far enough to leave a stranger's
floored neighbourhood is invisible to the reverse query, which runs against the
vector's new position.

A purge and a Vectorize-only write used to be on that list and are not any more.
The marker records the list ids it saw, not a row count, so a day that purges
two readings and ingests three still escalates and names the first missing id.
(Every id, not just the ready ones: a non-ready row can still own an indexed
vector, so its removal moves neighbourhoods too.) And `corpus backfill-vectors`
stamps `invalidated_by` on the marker before its first upsert, and again, with
a different value, after its last, so the next pass sweeps on its own. That
marker is the only R2 object it writes, and it needs an R2 write credential for
it; a stamp it cannot write before upserting stops the run before it spends
anything. A refresh pass that finds a stamp it did not start with leaves the
marker alone rather than clearing a sweep it did not perform, which is what the
second stamp is for: a pass that swept while vectors were still arriving must
not report the corpus as covered.

**Staging proof, 2026-09-02**, the measurement the default flip rests on
(`reading-lite-staging`, 39→47 readings, direct S3/REST path, `--tenant
global`; eight `--execute --sole-writer` passes, all exit 0). Passes 1–5 are the
protocol proper, full → incremental (quiet) → ingest 8 URLs → incremental →
full → full; 6–8 were added to price a second quiet night and to exercise the
escalation path deliberately. All eight, in order:

| # | invocation | scope taken | measured | wall | flagged |
|---|---|---|---|---|---|
| 1 | `--full` | full | 29 | 10.75 s | 0 |
| 2 | `--since-last-run` | incremental (0) | 0 | 1.00 s | 0 |
|, | *ingest leg, 8 URLs → 4 ready + 4 failed* |, |, | 118 s |, |
| 3 | `--since-last-run` | incremental (8) | 4 | 6.72 s | 2 |
| 4 | `--full` | full | 33 | 14.09 s | 2 |
| 5 | `--full` (immediate rerun) | full | 33 | 11.80 s | 2 |
| 6 | `--since-last-run` | incremental (0) | 0 | **0.98 s** | 0 |
| 7 | `--since-last-run` | **escalated**, 1 reading purged | 33 | 12.75 s | 2 |
| 8 | `--since-last-run` | **escalated**, 3 readings purged | 33 | 13.54 s | 2 |

Five of the eight were `--since-last-run` (2, 3, 6, 7, 8), which is the
denominator for the escalation rate below.

- **Flags were byte-identical** between the incremental pass and the sweep
  taken 19 seconds later: same two ids, same `connections`,
  `current_neighbours`, `novelty_verdict`, `reasons`, `judged_at`. The narrowed
  scope missed no flag.
- **Snapshot drift elsewhere was not zero, by design.** The sweep after the
  incremental rewrote two snapshots the incremental never measured, both X
  readings whose nearest score moved 0.221→0.239 and 0.172→0.268 as the four
  new vectors entered their raw topK. (Eight rows were ingested and entered the
  changed set; four reached `ready` and own a vector, and the other four are
  the "not ready, own no vector" half the scope planner skips.) Both sit far
  below the bound (0.45) and
  neither can change a flag. The immediately following sweep reported
  `Snapshot drift: 0`, so it is deferred, not lost. That is the
  exact-versus-approximate paragraph above, measured.
- **12–14x cheaper, and flat in N on a quiet night** (0.98 s against 11.80 s):
  the pass resolves an empty scope and returns before it opens Vectorize or
  reads a manifest, provided the marker carries no still-ready
  `unmeasurable_ids`, each of which costs a query and a manifest read on even
  the quietest night, by design. The measured runs took the ETag short-circuit (an unchanged
  `index/list.json` ETag ends the scope immediately), but the win does not
  depend on it, where no ETag is available, which is every wrangler-path run
  and any pass whose predecessor wrote a snapshot, `changedSince` falls back to
  the row timestamps and reaches the same empty scope. Modelled onto production (N=553 ready,
  unit costs 0.206 s per Vectorize query + 0.140 s per manifest read, plus the
  4 req/s Cloudflare cap): a sweep is ~3.5–4 min and an incremental night with
  ~10 changed readings ~15 s; at 10x corpus that is ~35–40 min against the same
  ~15 s.
- **Tier 1 spends no LLM or embedding tokens at all**, 0 across all eight
  passes. The scope buys wall clock and Cloudflare API calls, not provider
  spend. What it does change is how many readings tiers 2/3 are handed.
- **Escalation: 2 of 5 incremental passes (40%)**, both from purges deliberately
  induced by the measurement; excluding those, 0 of 3. Both escalations named
  their cause and cost ~1 s more than a plain sweep would have. The saturation
  hatch never fired.

Two numbers staging could not supply, so the flip does not claim them: the
production stranger fan-out per changed reading (staging's reverse queries
returned zero strangers, because that corpus is sparse and clustered, so
saturation there says nothing about production) and the natural production
purge rate. Both change the size of the win, not its sign.

A reading with no indexed vector, or a manifest that fails `ManifestSchema`, is
unmeasurable rather than unfinished. The pass records its id under
`unmeasurable_ids` on the marker, measures it again on every later pass until it
is repaired, and exits 3 so it stays visible, the marker advances past it
rather than pinning the whole scope on an ever-older timestamp. A failed query,
an unparseable manifest, a failed manifest write or a failed `index/list.json`
flush is different: that pass left work undone, so the marker stays where it was
and the exit is 1. Note what a frozen marker does and does not buy: the next
incremental pass re-covers everything changed since that older timestamp, which
is more than it would otherwise have looked at, but a reading that failed
without its list row moving is not named anywhere (unlike `unmeasurable_ids`),
so the weekly `--full` sweep is what actually finds it again.

**A whole sweep of unmeasurable readings is a different thing again.** A sweep
that measured *none* of its ready readings is not a corpus with a lot of broken
readings; it is a pass that could not read the corpus. A wrong `--vectorize`
index, a wrong `--tenant` namespace, an expired Vectorize credential and an
upstream failing every query all present this way. Advancing the marker there
would declare the whole corpus refreshed on the strength of zero measurements
and never look at it again, so the pass instead leaves both `last_run_at` and
`last_full_run_at` where they were, prints `Configuration failure: this pass
swept the corpus and measured 0 of N ready reading(s)` with the `no vector` /
`failed` / `schema-invalid` breakdown, and exits 1.

**Only a sweep reports one**, because only a sweep's scope is large enough to
say so, and because a sweep's scope comes from `index/list.json` rather than
from the marker, so it reaches the same verdict on the first pass as on the
hundredth, with no marker to bootstrap from. An incremental scope is routinely
one or two readings, often exactly the ones carried under `unmeasurable_ids` for
retry; calling that a configuration failure would freeze the marker on a single
broken reading, grow the scope every night, and page for it forever. On any
night that a ready reading changed, a misconfiguration surfaces anyway, that
reading's vector cannot be found, which escalates the scope to a sweep, and the
sweep reports it. On a night when nothing changed at all it does not: the scope
is then whatever an earlier pass carried under `unmeasurable_ids`, those all
answer "no vector" and the pass exits 3, or, if no pass ever got far enough to
record any, nothing at all, and it exits 0. **The weekly `--full` sweep is the
only guaranteed detector**, which is one more reason to keep it scheduled. A pass narrowed by `--only` or by a
`--limit` that truncated it never reports a configuration failure either, it
measured the subset it was told to, so naming one broken reading with `--only`
exits 3, not 1. Nor does a pass that threw partway through: the targets after
the throw were never attempted, so it reports the abort and exits 1 on that.

There is no minimum corpus size, so a small tenant, a staging or dev corpus of
one or two ready readings, both vectorless, sweeps, reports a
configuration failure, and stays there until someone repairs or re-embeds them:
exit 1 on every sweep, marker frozen. That is the intended
reading of the evidence (a corpus in which nothing is measurable is not a corpus
you can refresh), and on a corpus that small a permanent sweep costs nothing.
The production corpus is in no danger of it by size: a sweep there measures
hundreds of readings, so the condition cannot fire unless the index really is
unreachable. It can fire by state, though, a Vectorize namespace cutover that
has migrated R2 but not yet re-upserted the vectors leaves every ready reading
vectorless, which is what this condition is built to notice. Every sweep will
exit 1 for the length of such a window, while the nightly `--since-last-run`
may well go quiet, since a cutover moves no list rows, so pause the schedule or
finish the re-upsert (`corpus backfill-vectors`) before relying on either.

`--only <id>` overrides the scope: a named reading is measured whether or not
the scope would have selected it, and the pass resolves no scope at all rather
than paying for reverse queries it cannot use. The header then reads
`Scope: full — --only names N reading(s)`. `--limit` is different: it still
resolves its scope and then measures the first N of it, so the header and the
report keep saying `incremental`. The report records the narrowing under
`scope.narrowed_by`, always for `--only`, and for `--limit` only when it
actually cut the pass short, so the report and the marker agree about whether
the pass was partial. `--only` never advances the marker; `--limit` pins it
only when it actually cut the pass short, so a limit carried in a cron as a
cost valve and never reached still advances it.

Only a complete `--execute` pass advances the marker, a plan pass writes no
snapshots, `--only` names a subset, and a `--limit` that truncated the plan
measured one, and `last_full_run_at` moves only on a full sweep. A failed
marker write does not fail the run: the cost is the next pass sweeping.

```sh
# Nightly. --since-last-run is the default; spelled out so the schedule says
# which scope it means.
#
# UPGRADING AN EXISTING SCHEDULE: before this change the weekly sweep was a bare
# invocation with no scope flag. That exact line now runs incrementally and
# never sweeps. Scoped runs now warn when the full sweep is overdue. Add
# --full to the weekly cron at the same time as taking this change.
npm run ops -- corpus refresh-neighbours --tenant "$TENANT" \
  --since-last-run --execute --sole-writer
# Weekly. The sweep is no longer what a bare invocation does — it must be asked
# for.
npm run ops -- corpus refresh-neighbours --tenant "$TENANT" \
  --full --execute --sole-writer --out ./refresh-report-full.json
```

Scoped refreshes (invocations without `--full`) print a stderr warning when
`last_full_run_at` is missing, unusable, or **older than seven days**. Exactly
seven days is still within the threshold. The warning shows the timestamp and
age (or `age unknown`) and a full-sweep command for the selected tenant,
bucket, Vectorize index, and storage path (`--via`). On the direct path the
warning also names the Cloudflare account stdout would have printed, so a
stderr-only log is enough to check before `--execute`. Check the external
weekly schedule and run that command after pausing/draining concurrent
writers for `--sole-writer`.

Plan and execute evaluate the same stored timestamp before resolving scope,
including quiet runs and runs that automatically escalate to full. The warning
itself changes neither corpus state, scope, nor exit status. A completed full
execute pass clears it for subsequent runs; a plan, failed pass, or incremental
pass cannot refresh the full-sweep timestamp. Automatically escalated full
passes count as sweeps. Existing marker rules still apply: partial selections
do not advance it, while a completed sweep that carries unmeasurable readings
can advance it and exit 3. Those readings still need the reported repairs.

Give every writer of a refresh report its **own `--out` path**, the nightly,
the weekly sweep, and any ad-hoc run, and point each schedule's tier-2/3 run at
its own report:

```sh
# Weekly, consuming the sweep — not the nightly report.
npm run ops -- corpus refresh-connections \
  --tenant "$TENANT" --report ./refresh-report-full.json
npm run ops -- corpus refresh-tensions \
  --tenant "$TENANT" --report ./refresh-report-full.json
```

Both tiers default to `./refresh-report.json`, and an incremental report is a
statement about its scope: sharing one path would let a nightly pass, or an
ad-hoc interactive one, overwrite the sweep's corpus-wide report with a
scope-limited and often empty one, exit 0, and leave tier 2/3 judging a handful
of readings while believing they had the sweep. The tier-2/3 commands echo the
report's scope header but neither refuses nor warns about its scope. Consume the
sweep's report promptly, though: both `refresh-connections` and
`refresh-tensions` reject a report whose readings were rewritten after it was
generated.

### Refresh exit codes

`ops corpus refresh-neighbours` distinguishes work the *operator* owns from work
a *reading* owns, so a nightly schedule can alert on one and file the other:

| Code | Meaning | Who acts |
|---|---|---|
| 0 | Nothing outstanding. | nobody |
| 1 | Real work left undone, and the marker did not move past it: a configuration failure (above), a failed Vectorize query, an unparseable manifest, a failed manifest write, or a failed `index/list.json` flush. | operator, re-run, or fix the index/credentials first |
| 2 | Usage error: an unknown flag or a missing `--tenant` (the dispatcher), or a refusal of the same shape from the command itself, `--execute` without `--sole-writer`, `--since-last-run` with `--full`, `--via direct` with `--local`, a non-integer `--limit`. | operator, fix the invocation |
| 3 | The pass itself completed, but specific readings need a human: no indexed vector, or a manifest that fails `ManifestSchema`. | someone, repair those readings (`corpus backfill-vectors`, `corpus recover`); re-running changes nothing |

The line between 1 and 3 is whether re-running the same command could help. It
can after a 1 and cannot after a 3, which is why a 3 is not a page: on a pass
eligible to advance the marker, the ids are carried under `unmeasurable_ids` and
every later pass retries them. The exit line says whether the marker actually
moved, because the passes that never advance it, a plan pass, `--only`, a
truncating `--limit`, an invalidation arriving mid-pass, can all exit 3 too.

The codes apply in plan mode as well as under `--execute`; a dry run reports
what it found. Two existing behaviours change, in opposite directions, so a
scheduled run wants the `case` below rather than a bare `if`: a pass that finds
a reading with no indexed vector used to exit 0 in plan mode and now exits 3
(or 1 if the sweep measured nothing at all), while a pass whose only complaint
is an unmeasurable reading, no vector, or a manifest failing `ManifestSchema`, used to exit 1 and now exits 3. A wrapper that pages on 1 stops paging for
that second case, which is the point: it is a ticket, not a page.

There is no cron wrapper script in this repository, and nothing in git schedules
a refresh pass, the nightly and weekly invocations above are scheduled by the
operator, directly, so a scheduler wanting this distinction has to make it itself (the same `case`
serves the weekly `--full` sweep):

```sh
npm run ops -- corpus refresh-neighbours --tenant "$TENANT" \
  --since-last-run --execute --sole-writer
case $? in
  0) ;;            # clean
  3) file_ticket ;; # specific readings need repair; the pass itself was fine
  *) page ;;        # 1 (re-run or fix infrastructure) or 2 (bad invocation)
esac
```

`refresh-connections` and `refresh-tensions` keep the plain 0/1 contract. Every
non-zero cause they have, a planning read that failed, a judgement that failed,
a lost manifest CAS, a `--max-backoff` ceiling, and for `refresh-connections`
the `index/list.json` flush it alone performs, is a re-run-or-fix case, which
is code 1 under the same rule. Code 3 stays reserved
in those two commands rather than mapped onto their nearest analogue (a live
manifest that is invalid at plan time), because that condition currently shares
one `planningFailed` flag with transient read errors, and splitting it is a
separate change.

`ops corpus refresh-connections` consumes that report and rejudges only the
flagged readings. Plan mode validates the report tenant and every live target,
prints the provider/model/effort, each selected judgement, and estimated
synchronous cost, then exits without a provider call or storage write. Both
tier-2 and tier-3 passes echo the report's scope header (`Scope: incremental
(12 reading(s)), …`, `Scope: full, …`, or `Scope: unstated` when the report
carries no header). Missing is not inferred as full: pre-header
`refresh-neighbours` already accepted positional IDs and `--limit`, so a
header-less report may be a hand-picked or capped subset.

```sh
npm run ops -- corpus refresh-connections \
  --tenant "$TENANT" --report ./refresh-report.json

# Start with a controlled production write after pausing and draining every
# corpus writer for the selected tenant.
npm run ops -- corpus refresh-connections \
  --tenant "$TENANT" --report ./refresh-report.json \
  --execute --sole-writer --limit 1
```

Execute mode reads the target's stored summary and judges it only against live,
ready neighbours carried by the report. It drops provider ids outside that
set, preserves an existing connection object when the provider reaffirms its
id, and replaces `connections`, `novelty_verdict`,
`connections_computed_at`, and `connections_neighbourhood_ids`. Manifest writes use ETag CAS against the ETag the
planning read returned, execute re-reads nothing, so a manifest that changed
between the plan and the write loses that conditional write and is reported as
a CAS loss. The judgement is made before that write, so a CAS loss is a
judgement already paid for and thrown away, a run of them is a run of wasted
spend, not just wasted writes. Under `--sole-writer` nothing should change in
that window. The list index is written after successful manifest updates so its
verdict matches the manifest: that flush is itself an `If-Match`
read-merge-write, retried with jittered backoff, and it writes only the
`novelty_verdict` of the rows this run judged or healed.

The manifest timestamp is the resume marker. If a manifest write succeeds but
the list write fails, rerun with the same report: the command heals the list row
without another paid judgement. `--limit` caps judgement and healing actions.
Provider errors and lost CAS races leave the reading ready and never blind-write
over newer state. The price estimate uses a four-UTF-8-bytes-per-token
approximation, a 256-output-token assumption, and the dated price table printed
by the command; it is a planning estimate, not a bill. Execute mode prints the
tokens the provider reported for each judgement and a run total (`Usage: …`),
counted as soon as the call returns so a judgement that is billed but then
fails to write still appears. The reasoning column is the reasoning share of
the output count, not an extra charge on top of it; OpenAI breaks that share
out, Anthropic does not, so the column is shown only for OpenAI. The input
column excludes Anthropic cache reads and writes, which are billed on top of
it.

Execute mode runs several judgements at once. `--concurrency <n>` sets how
many, defaulting to 4, the ingest queue runs at 3 against the same provider
account, so this is deliberately close to it, and refusing anything above 16,
so a mistyped flag cannot fan a hundred paid calls at that account. Results are
collected and printed in plan order however the calls complete, and every
counter (`Judged`, `list rows healed`, `failures`, `Usage:`) is folded in that
same order, so a run's output and its exit code do not depend on which call
returned first. The lines that are not in plan order are the rate-limit pause
and the backoff ceiling below, which print when they happen because that is the
point of them. The cost of that ordering is that a finished action's line waits
for the ones planned before it, so a single slow call holds back the lines
behind it; the `Timing:` block at the end is still what separates a slow pass
from a hung one. Pass `--concurrency 1` for a strictly sequential pass, the
rate-limit backoff below still applies.

Two things the pass does not do concurrently. It never has two judgements
holding the same reading at once, in `refresh-tensions`, where a reading sits
in several pairs, an action waits until every reading it writes is free, so
concurrency cannot manufacture a lost CAS or pay for a judgement it then throws
away. And when a judgement comes back rate limited, the whole pass backs off
together. The judge's own retry never covers a 429, it retries 5xx and network
faults, and turns the first 429 into a typed error immediately rather than
sleeping inside the provider call, so this backoff is the only thing pacing a
rate limit: no worker *starts* another judgement until the provider's
`Retry-After` has passed (defaulting to 8 s, capped at 60 s so a wild header
cannot park a sole-writer window). Calls already in flight when the window opens
still finish, and are still billed. The pause prints as `provider rate limited;
pausing new judgements for …`. Workers wake together at the end of a window, so
a limit that is still in force costs one more round of 429s before the next
pause.

The action that hit the limit gets one more attempt, once that window clears. A
429 is usually a queue that has moved on by the time the window is over, so the
retry is what keeps a transient limit costing the pass a pause rather than a
reading. A second 429 on the same action is not a blip: it is counted as a
failure, exactly as a sequential run would have counted it, and never retried a
third time. The run does not abort, and it does not silently re-bill an action
that succeeded.

The total time a pass will spend waiting out limits is bounded by
`--max-backoff`, which defaults to `10m` and takes a duration (`600s`,
`600000ms`, `20m`; a bare number is seconds).

**`--max-backoff` accepts `30s` to `30m`, inclusive; anything outside that range
is a usage error (exit 2).** Below the floor the pass would stop on the first
limit it met, since one honoured window already costs up to 60 s; above the
ceiling the budget has stopped bounding the sole-writer window it exists to
bound. Both ends catch the same unit confusion: `10` is ten seconds, `600m` is
ten hours. A cron entry carrying a larger value from before this range existed
now fails at parse time rather than running unbounded, `2h` was a documented
example here and is no longer accepted.

What counts against it is the
window each limit opens, not each worker that reports one, so a whole round of
workers walking into the same wall is a single charge, and a limit landing
inside a window already open costs nothing at all. It is charged when the
window opens rather than measured as it is served, so a pass whose workers were
mid-call for part of a window is charged more than the wall time it actually
lost; the budget bounds the stall from above. When the next window would
overrun it, the pass stops dispatching judgements: it prints `the next backoff
would pass this pass's … rate-limit ceiling`, lets the judgements already in
flight finish and write their results, reports every judgement it did not reach
as `skip …: backoff ceiling reached before this action ran`, and exits
non-zero. That is what keeps a hard-limited provider from sitting on a scarce
sole-writer window for the length of the plan. The skipped judgements were
never touched, so a rerun when the provider is quieter picks them up unchanged.

The budget is cumulative for the whole pass and nothing resets it, so a long
pass against a provider that limits intermittently can reach the ceiling while
still making progress between windows. That is deliberate, the bound is on how
much of the sole-writer window a pass may spend waiting, not on how badly it is
being limited, but it is the case to raise `--max-backoff` for, up to its `30m`
ceiling. A pass that still cannot finish inside that is one to split with
`--limit` and resume when the provider is quieter, not one to park on the
sole-writer window for hours.

The ceiling bounds the paid work only, on the same rule as `--limit`: a list
heal or an integrity repair makes no provider call and cannot be rate limited,
so the pass still runs the free work behind the ceiling before it exits.

Ctrl-C is safe at any point: every manifest write is a completed CAS, and a
rerun resumes from the manifests as it always does.

Because the calls overlap, every `Timing:` row a concurrent action produces, `provider`, `manifest write`, and for `refresh-tensions` `manifest read`, sums
the call durations rather than the wall time they occupied, the same way
`planning reads` already did, so under `--concurrency` a row can exceed the
run's own total. The `total` row is the one to compare between runs.

Run a fresh neighbour refresh immediately before this command. The report must
name the same `--tenant`; a mismatched selector is refused. The sole-writer
window must cover provider calls, manifest CAS writes, and the final conditional
`index/list.json` merge. The command also refuses the report if a target or
candidate neighbour was reprocessed after the report was generated.

`ops corpus refresh-tensions` is the pairwise sibling. It reads the same
report, pairs every flagged reading with each live ready neighbour, collapses
both directions onto one pair, and keeps only pairs whose stored manifests
share a named person or organization, at least a fifth of their keywords
(Jaccard ≥ `TENSION_KEYWORD_JACCARD_MIN` in
`scripts/corpus-lib/refresh-tensions.ts`), or an existing connection. Tags
and the similarity score alone never qualify. Pairs both sides already
remember judging (`tensions_judged`) since their last ingest write are skipped.
Plan mode prints each pair with its overlap evidence and estimated cost plus
every free repair, and writes nothing.

```sh
npm run ops -- corpus refresh-tensions --tenant "$TENANT" --report ./refresh-report.json

# Hand-pick a pair known to conflict. With --pair the report is read only
# when --report is passed explicitly.
npm run ops -- corpus refresh-tensions \
  --tenant "$TENANT" --pair rd_older,rd_retraction --execute --sole-writer
```

Execute mode makes one pairwise provider call per selected pair and writes
each side's directional entry, `contradicts` (symmetric), `supersedes` /
`superseded_by`, `qualifies` / `qualified_by`, always from that reading's point
of view with one shared reason, plus a `tensions_judged` record to BOTH
manifests with ETag CAS, against the ETags the planning reads returned; only a
side an earlier action in the same pass already wrote is read again. A `none`
verdict removes any prior entry for the pair
and is remembered so the pair is not re-judged nightly. Only `tensions` and
`tensions_judged` change; `updated_at`, connections, and every summary field
stay byte-identical, and `index/list.json` is never written. `--pair` bypasses
the overlap filter and the judged skip but both sides must still be live ready
manifests. `--limit` caps paid judgements only; free repairs always run.
`--concurrency` and `--max-backoff` work as they do for `refresh-connections`
above, including the rule that two actions touching the same reading never run
at once.
Execute mode prints the provider token usage of each judgement and a run total
on the same terms as `refresh-connections` above.

The two writes are not atomic. If the second CAS write loses, the command
reports the pair as one-sided; the next run mirrors the inverse entry to the
other side without a paid call as long as that side has not been reprocessed
since the judgement. A partner reprocessed since (its `updated_at` is newer
than the entry's `computed_at`) makes the stored judgement stale: the entry is
dropped, and the pair is re-judged when the report next pairs them. An entry
whose partner is not a ready list row (deleted, in practice: a ready reading
does not normally regress to failed or pending, and one that comes back ready
is rebuilt without tensions and must be re-judged anyway) is purged from the
holder together with its judged record, so tier 1 stops flagging the holder.
`DELETE /api/readings/:id` and `ops corpus purge-connections` leave inbound
tensions alone; until the next tension refresh purges them, tier 1 flags each
holder `stale_connection` and `refresh-connections` spends one relationship
re-judgement on it. Run `refresh-tensions` in the same window to keep that to
one call per holder. A successful reprocess rebuilds a manifest without its
tensions on purpose. The partner keeps its entry until a report or `--pair`
brings the two readings into a run again: tier 1 flags neighbourhood drift,
not summary changes, so that can take a while, and the pair is re-judged only
when the report pairs them. A failed reprocess keeps the tensions but still
bumps `updated_at`, so that reading's pairs are re-judged once at the usual
cost. Repairs are found among the readings the report or `--pair` names, not
by a corpus-wide scan. A stale report (any reading it names was rewritten
after it was generated) is refused even when `--pair` names the drifted
reading; regenerate it or omit `--report`.

Deploy a Worker whose `ManifestSchema` knows `tensions` **before** the first
production `--execute`: the Worker parses every manifest it reads with
`.strip()`, so an older Worker rewriting a manifest (a reprocess or a
preserve-and-roll-forward) would silently drop the field.

`ops corpus rebuild-list` re-projects every indexed manifest through
`manifestToIndexItem` and writes `index/list.json`. Use it after deploying a
Worker that added list-row fields (keywords, for `q` search) so existing
readings become searchable without a paid reprocess. Dry-run by default;
`--execute` requires `--sole-writer` because the rewrite is a plain put.

```sh
npm run ops -- corpus rebuild-list --tenant "$TENANT" --bucket reading-lite
npm run ops -- corpus rebuild-list --tenant "$TENANT" --bucket reading-lite --execute --sole-writer
```

Deploy the new Worker **before** the production rewrite. An old Worker that
later commits a terminal manifest would strip the new fields off that row.

### Purging connections to a deleted reading

`ops corpus purge-connections` is the explicit offline cleanup for inbound
`connections[]` entries that still name one deleted reading. `DELETE
/api/readings/:id` deliberately does not scan the corpus, enqueue cleanup, or
write a tombstone, so a reading-detail link may return 404 until an operator
runs this sweep. Cleanup is not automatic.

```sh
# Production founder namespace. Resolve $TENANT from whoami first.
npm run ops -- corpus purge-connections --tenant "$TENANT" --id rd_deleted

# Apply after establishing the sole-writer window.
npm run ops -- corpus purge-connections \
  --tenant "$TENANT" --id rd_deleted --execute --sole-writer

# Pre-tenant leftover copy, or a gate-off env (local).
npm run ops -- corpus purge-connections --tenant global --id rd_deleted
```

The target id must be absent from the selected namespace before the scan and
again immediately before mutation. The command refuses a present target or any
malformed canonical manifest, with no preflight writes. Only exact
`readings/{year}/{month}/{timestamp}-{id}/manifest.json` objects enter the
scan; nested attempt or backup objects and other manifest-shaped JSON are
ignored. Each selected key must also round-trip from the parsed manifest's
`id` and `created_at`. The command compares the bare `id` inside each
connection even when R2 object keys are tenant-prefixed, removes every exact
match, preserves unrelated connection order and manifest fields, and is
idempotent when rerun.

`--execute` is accepted only with `--sole-writer`. For this command,
`--sole-writer` is the operator assertion that no ingestion, reprocessing,
deletion, or recreation can mutate the selected corpus for the command's full
duration. Each manifest update still uses its listed ETag as an `If-Match` CAS.
On conflict the command boundedly re-lists, validates, proves the target is
still absent, recomputes against the newest manifest, and retries; it never
blind-writes. Exhaustion or target recreation exits nonzero and reports whether
earlier manifests were already changed.

The single-line JSON audit reports `mode`, the explicit tenant/global selector
(and `tenant_audit_stamp.tenant_id` for tenant mode), `target_id`, manifests
scanned and matched, matching entries, manifests written or that would be
written, unchanged manifests, conflicts, retries, failures, and
`partial_execution`. Failures also include a bounded `failure_code` and
`failure_stage`; provider response bodies and credentials are never copied
into the audit or error stream. The command emits exactly one final audit even
when a later storage operation fails after earlier writes. R2 listing
pagination is completed by the shared client and canonical manifest keys are
processed in deterministic lexical order.

`ops corpus recover` has two execution paths: `--wave` paces realtime
submissions through `POST /api/readings/:id/reprocess`, and `--batch` routes the
same work through the offline provider Batch API path described below.

```sh
npm run ops -- corpus audit --tenant "$TENANT" --execute      # writes index.json + INDEX.md
npm run ops -- corpus recover --tenant "$TENANT" --index ./index.json --execute
```

### Founder corpus migration (s1k.6)

**Completed; tooling retired.** Production cutover finished on 2026-08-31,
with counts/hashes, tenant paths, vectors and connections reconciled. The
[cutover report](founder-cutover.md) preserves the procedure and acceptance
record. The one-time `ops corpus migrate-founder` command, its planner/state
module and dedicated tests have been removed from the supported CLI. The
[last pre-retirement implementation](https://github.com/brian-bell/reading-lite/blob/b74a9b69af96b7101300d974e808e91ba34abdf9/scripts/ops-lib/commands/corpus-migrate-founder.ts)
and its tests remain available in Git history for historical recovery analysis.

New environments start with tenant storage. Rebuilt environments need their
restored tenant data verified before activation; the [activation guard](#tenant-mode-activation-guard)
remains. Retiring this command does not delete retained legacy data, remove the
`TENANT_DATA_PLANE` gate, change D1 schema migrations, or remove general corpus
repair/vector-backfill tools. A future migration needs its own scoped design,
tests and rehearsal, not a recurring founder-cutover release check.

### The extract-agent

The Worker enforces per-hop scheme, DNS-vs-private, redirect, size, and time
limits on every extraction fetch. Cloudflare private-egress blocking is not
that contract. Some sites still hard-block datacenter egress, so
`fetch_source` fails where a residential IP succeeds. `ops extract agent` is
operator-local recovery: it polls the reading API for `fetch_source`-failed
readings and re-extracts them locally, an SSRF-guarded static tier with
browser headers, falling back to a headless Playwright render when the static
tier is challenged or finds no real article, plus an anonymous Reddit
thread-JSON path. Playwright is not in the hosted product path. Successful
markdown re-enters through `POST /api/readings/import-markdown`.

```sh
npm run ops -- extract agent [--execute] [--limit N] [--only <id|url>] [--verbose]
```

Every submit is a paid action, so runs plan by default and are capped per
run. Plan mode persists nothing; on `--execute` a lockfile prevents two
overlapping runs from double-submitting, the run appends a JSON line to the
run log, and a completed run pings a dead-man healthcheck. Configuration lives in `.extract-agent.vars` (gitignored)
or the environment; the knobs are documented in
`scripts/extract-agent-lib/config.ts`. Reddit threads that answer with a
challenge are recorded as durable `manual` outcomes and left for the
`reddit-import` skill.

## Bulk ingest

### Chrome bookmarks

Ingests URLs from a Chrome bookmark export, asking `Y/n/q` before each URL
(Enter or `y` submits, `n` skips, `q` aborts).

```sh
npm run ops -- import bookmarks --file ~/Downloads/bookmarks.html --execute
npm run ops -- import bookmarks --file ~/Downloads/bookmarks.html --execute --quick
npm run ops -- import bookmarks --file ~/Downloads/bookmarks.html --execute \
  --folder "Computing/AI/MCP" --url https://readinglite.ai/api/readings
```

The default folder is `Computing` (top-level, i.e. under "Other Bookmarks").
`--url` is the **full** readings endpoint (default `http://127.0.0.1:8787/api/readings`,
or `READER_URL`). Omitting `--execute` prints the would-submit list without prompting or
POSTing. `--quick` skips the per-URL prompt; submission is always serial so the
local index can't race itself. Token resolution mirrors `ops reading submit`:
`--token` > `READER_API_TOKEN` env > `.dev.vars`.

Transport-level fetch failures retry twice (250 ms / 500 ms); errors surface
their underlying cause. `new`/`existing` responses are recorded in
`.import-bookmarks-index.json` (scoped per destination URL) immediately, so an
interrupted run resumes; errors are *not* recorded, so the next run retries
them. The Worker also dedupes via the by-url pointer, so deleting the local
index is safe, it just re-POSTs every URL once to rebuild it.

### Local markdown

Imports `.md` files without re-fetching their source URLs. Each file must carry
a source line:

```md
**Source:** https://example.com/article
```

That URL becomes the canonical reading URL and the body is sent to
`POST /api/readings/import-markdown`. Duplicate files sharing a source URL are
collapsed before submit, the largest file wins. Imported readings store the
markdown as both raw content and `extracted.md`, then reuse the normal
embedding, similarity, summary, Vectorize, manifest, and list-index pipeline.

```sh
npm run ops -- import markdown --dir ~/Documents/articles           # plan, no token needed
npm run ops -- import markdown --dir ~/Documents/articles --execute  # local dev
npm run ops -- import markdown --dir ~/Documents/articles --execute \
  --url https://readinglite.ai/api/readings/import-markdown
```

`--url` is the full import endpoint; token resolution matches the other scripts.
Files above the Cloudflare Queues 128 KB message limit are blocked before any
POST. Successful new/existing responses are recorded in
`.import-markdown-index.json` (scoped by destination URL) and move every file
for that source URL into a `processed/` subdirectory. The CLI accepts `--email`, but hosted import delivery is always silent;
the send-time policy ignores notification requests for imports.

### Provider Batch APIs

`import-markdown` summarizes every file **realtime** through the Worker queue.
For large backfills, `ops corpus ingest` runs the same directory through the
configured provider's **Batch API**, and `ops corpus recover --tenant "$TENANT" --batch` does the same
for readings already in the corpus. Both talk to R2 and Vectorize directly with
`CORPUS_R2_*` credentials rather than through the HTTP API, and both need
`CORPUS_CF_API_TOKEN` plus `OPENAI_API_KEY` (embeddings); `ANTHROPIC_API_KEY` is
needed only to start or resume an Anthropic batch. `--execute` requires the
applicable credentials; a dry run degrades to the local plan without them. There
is no cross-provider fallback.

```sh
# dry run (default): print the plan; with creds it also shows ownership skips
npm run ops -- corpus ingest --tenant "$TENANT" --dir ~/Documents/articles

# for real — confirm the realtime writer is paused/drained first
npm run ops -- corpus ingest --tenant "$TENANT" --dir ~/Documents/articles \
  --execute --sole-writer --bucket reading-lite
```

The resulting `ready` manifests are contract-compatible with the realtime import
path (`source_type: "markdown"`, captured content, correct
`content_bytes`/`content_sha256`, `usage.openai_embedding_tokens`, by-url and
by-id pointers, a Vectorize vector, and an `index/list.json` row). Both batch
paths stamp a terminal `last_attempt` summary in the manifest, but they do not
write the realtime per-attempt objects under the key prefix. A resumed
pre-upgrade sidecar without attempt identity retains the legacy omission of
`last_attempt`.

**`--sole-writer` is enforced, not assumed.** `ops corpus ingest --tenant "$TENANT" --execute` and
`ops corpus recover --tenant "$TENANT" --batch --execute` refuse to submit without it. Both batch paths
eagerly claim by-url slots (recover via a failed→pending flip that keeps its
claim on failure, so the URL stays re-submittable), but that claim is
defense-in-depth rather than a replacement for pausing the realtime writer. An
acknowledged run prints a loud banner before any submit; dry runs submit nothing
and never require the flag. The enforcement lives in
`scripts/corpus-lib/sole-writer.ts`.

**Idempotency** is resolved client-side from `index/by-url/{sha256(url)}` by the
same rules as the Worker's `ReadingClaim`: a pointer counts as owner only when
its manifest actually matches (id + url + url_hash), so ready and pending owners
are skipped while failed owners re-ingest in place; a fresh pointer whose
manifest hasn't landed yet is treated as still-initializing and skipped (a
realtime submit may be in flight); unclaimed URLs mint a new reading; and
damaged or mismatched pointers are skipped for operator repair rather than
claimed over. With no by-url pointer at all, the tools first run the Worker's
cold-legacy lookup (`findManifestByUrl` over `index/list.json`), so a prior
legacy failed ingest with a by-id pointer and list row but no by-url pointer is
re-ingested in place instead of duplicated. Pending owners are skipped even past
`PENDING_TTL_SECONDS`: this offline path cannot safely supersede a queue worker
that may still be running, so a stranded pending is left to heal via the
realtime API or `ops corpus recover`.

**Sizing.** Before any fresh eager activation write, the batch path preflights
the provider payload, resolves similar-reading context, then validates the final
request payload. OpenAI JSONL is measured as exact UTF-8 bytes and capped at
50,000 requests and 190 MB; Anthropic payloads use a 200 MB safety cap. If a run
is too large, rerun with `--limit` to split it without leaving pending owners
behind.

**Resume.** The in-flight batch is recorded in a versioned sidecar
(`./corpus-ingest.batch.json` by default); re-running resumes that batch instead
of creating a second, double-billed one. The sidecar pins provider, model,
OpenAI reasoning effort, and a stable run id, so an environment change cannot
switch a resume to another provider. New Anthropic batches send
`output_config.effort` from `ANTHROPIC_SUMMARIZATION_REASONING_EFFORT` on the
same request body as realtime (`low`, `medium`, `high`, `xhigh`, or `max` on
Claude Sonnet 5; invalid values fail closed before submit). OpenAI's pre-submit upload/create phases are
persisted, a companion `<sidecar>.input.jsonl` holds the exact JSONL bytes,
written before the `uploading` checkpoint. On resume the reconciler adopts what
already exists: remote files by filename (`reading-lite-${runId}.jsonl`), remote
batches by `metadata.run_id`. A sidecar-scoped file lock serializes the initial
upload/create transition against any later resume.

The expensive `create` step is deliberately **fail-closed**: a list-then-create
cannot distinguish a successful-but-lost-response prior create from a failed one
(the OpenAI Batch API has no idempotency key, and listing can lag), so an
ambiguous match or no visible remote batch at the create step aborts and asks
for a manual reconcile. Anthropic pre-submit and OpenAI `activating` sidecars
also require manual reconcile. If a batch fails, the write phase releases the
eager by-url claim only when the pointer still exactly matches the failed target.

Claim, release, and crash-resume semantics are specified in
`scripts/corpus-lib/batch/activation-phase.ts`, `write-phase.ts`,
`prepare-fresh-markdown.ts`, and `openai-reconcile.ts`; `run.ts`'s header
documents the shared phase ordering.

## X threads

Submitting an `x.com/<user>/status/<id>` or `twitter.com/<user>/status/<id>`
URL retrieves the linked author's same-author self-reply component through the
X API. Sharing a middle post includes its author-written ancestors and
descendants; audience replies and author side conversations reached through an
audience reply are excluded. Quoted posts are rendered as context but their
threads are not traversed. The raw artifact is the bounded aggregate API JSON,
and the reconstructed Markdown is used as the reading body.

This path requires `X_API_BEARER_TOKEN`. It uses only
`/2/tweets/search/recent`, consumes every pagination token, and never falls back
to full-archive search or X's JavaScript page shell. If the conversation root is
outside the seven-day recent-search window, the reading lands `failed` with:

> This X thread is older than the 7-day recent-search window and cannot be imported.

This personal tool does not implement X deletion/edit compliance
synchronization.

## Comparing summarizers on production readings

To compare OpenAI (including `max`) and Anthropic Sonnet on one or more
**existing production readings**, use the compare-summary-effort skill, not
`ops eval summarizer` (that is the fixture-based quality matrix).

```sh
npx tsx .agents/skills/compare-summary-effort/scripts/compare-summary-effort.ts \
  --target rd_EXAMPLE \
  --target 'https://example.com/article' \
  --model gpt-5.6-luna \
  --effort max
```

Plans by default (prints the readings × candidates matrix and a conservative
cost ceiling). `--execute` is the only paid path. Production is GET-only: no
`/reprocess`, no manifest/vector/list writes, no wrangler or production config
change. Anthropic effort is optional; omit `--anthropic-effort` to run Sonnet
once with no effort field. See `.agents/skills/compare-summary-effort/SKILL.md`.

## Sources that need a local skill

### Reddit

Reddit serves a bot challenge to datacenter egress, so the Worker cannot fetch
thread JSON, `POST /api/readings` with a `reddit.com` / `redd.it` URL
deliberately lands `failed`. Use the **`reddit-import`** skill instead: it drives
a logged-in Chrome session to fetch the public `<thread>.json`, renders the post
plus top comments to markdown with the same parser the Worker uses, and imports
it via `POST /api/readings/import-markdown`. No Reddit app or OAuth credentials
are needed. The skill wraps `ops import reddit <redditUrl> --json <saved.json>`,
which plans by default (omit `--execute`) to preview the markdown.

### YouTube

YouTube watch pages have no server-rendered article body, so the extractor
handles them in-worker rather than through Readability. Submitting a
`youtube.com/watch`, `youtu.be`, `shorts`, `live`, or `embed` URL builds markdown
from the public oEmbed metadata (title + author, the reliable floor), plus a
best-effort description (from the page's `ytInitialPlayerResponse`) and
transcript (the first caption track) when YouTube serves them. Unlike Reddit the
URL summarizes to `ready` directly, but in practice the Worker is usually blocked
from the watch page and lands the floor only.

For a full extraction, description plus transcript, run the
**`youtube-import`** skill locally, which fetches the watch page from your
residential IP and uses `yt-dlp` for the transcript, then imports the rich
markdown through the same parsers the Worker uses. Requires `yt-dlp` on PATH.

```sh
npm run ops -- import youtube "<youtubeUrl>" --execute   # omit --execute to preview
```

## Seeding local R2

To exercise the read path or the SPA against real data locally, seed the local
bucket and then restart `wrangler dev`, the running dev server caches R2
in-process. Seed via **Miniflare** (persist path `.wrangler/state/v3/r2`, bucket
`reading-lite`), *not* `wrangler r2 object put --local`, which writes to a
different local store the dev server never reads.

`key_prefix` already begins with `readings/`; do not prepend it again.
A minimal `ready` reading needs:

- `<key_prefix>/manifest.json`, a valid `ManifestSchema` with
  `content_status: "captured"`
- `index/by-id/<id>`
- `index/by-url/<url_hash>`, matching the manifest's `url_hash`
- a row in `index/list.json`
- `<key_prefix>/extracted.md`, for `/content`
- `<key_prefix>/raw.{ext}` matching the manifest's `content_type`, for
  `/content/raw`

`/lookup` requires the by-url pointer and does not discover pointerless readings.

## Paid-work policy and accounting

Use `npm run ops -- system status --env staging|production [--tenant usr_…]`
to inspect policy and charged spend. `system policy` plans changes by default;
writes require `--execute --acknowledge-guard-version <current row version>`
and production also requires `--confirm-production`. See
[the paid-work operator runbook](paid-provider-spend.md#operator-policy-and-accounting)
for setup, exact commands, version/retry semantics, and accounting limitations.


## Relationship refresh queue plumbing

Hosted processing requires Workers Paid; `usage_model: standard` alone does not
establish that subscription. Both hosted environments pin `limits.cpu_ms=30_000`.
See the [CPU diagnosis and recovery procedure](relationship-refresh-recovery.md)
before resuming a run interrupted by CPU terminations.

`RELATIONSHIP_REFRESH_JOBS` uses dedicated queues
`reading-lite-staging-refresh` / `reading-lite-staging-refresh-dlq` and
`reading-lite-refresh` / `reading-lite-refresh-dlq`. `ops staging setup` and
`ops staging teardown` manage the staging pair. Provision the queue pairs before
Worker deployment; the production DLQ must be created separately, like the other
production DLQs (`wrangler queues create reading-lite-refresh-dlq`).

`RELATIONSHIP_REFRESH=1` is configured in staging and production with a
two-judgement nightly cap. The owner-authorized single actual staging run passed
on 2026-09-08 before production enablement. See [staging evidence](relationship-refresh-staging.md).
Gate-off queue deliveries acknowledge and discard without storage/provider
access; the refresh cron also does nothing. DLQ deliveries log and acknowledge
without changing manifests.

With the gate set to `1`, the separate `7 3 * * *` cron (03:07 UTC nightly)
starts or resumes a full scan for the active account matching `FOUNDER_EMAIL`.
`TENANT_DATA_PLANE=1` is required. The existing */15 digest/wipe cron is separate.
Each queue shard reads at most 25 manifests and queries their stored vector IDs;
no embedding calls are made. Missing, non-ready, reprocessing and purged readings
are skipped. The existing offline neighbourhood-drift rules select judge targets.
All scan shards finish before any judge jobs are enqueued.

Progress lives at `u/{tenantId}/index/refresh-cursor.json`: the scan's fixed target
list, scan offset, flagged candidates, dispatch offset and nightly allowance.
Cursor writes use CAS. `REFRESH_MAX_JUDGEMENTS` defaults to `100` and accepts
integers 1–1000. The cap counts distinct reserved judge jobs per nightly budget,
not delivery attempts. Remaining candidates carry into later nights without
rescanning; a fresh full scan begins on a later night after dispatch completes.
The scan does not read or update the offline `index/refresh-state.json` marker,
or rewrite similarity snapshots, manifests, list rows or vectors.

A pending batch reserves allowance before sending. Failed/uncertain sends retain
that reservation; the next scheduled invocation recovers a lost continuation.
Retries can deliver the same `(runAt, readingId)` judge identity more than once.
The judge consumer deduplicates that identity before paid work and revalidates
the tenant and reading. Pending batches keep their original allowance
until their send is confirmed; a recorded new-night allowance then takes effect
immediately so recovery does not skip that night. Invalid cursor data fails closed and is retained
for diagnosis rather than silently restarting a run.

Issue #175 slice 3 consumes judge jobs with the configured OpenAI or Anthropic
relationship adapter. It reads the stored summary and current floored neighbours;
it does not extract, embed, re-summarize, change status, or refresh tensions.
Each HTTP attempt presents the shared processing leases and passes tenant/global
spend admission. Refresh does not consume a new-reading quota slot.

Migration `0014_relationship_refresh_jobs.sql` adds one latest checkpoint per
reading to D1. After admission and immediately before fetch, the delivery marks
that job dispatched. HTTP retries within that delivery each receive fresh spend
admission. Confirmed 429 responses record a retry time and remain eligible for
delayed re-enqueue with fresh admission; early duplicates honor Retry-After.
Expected lease/spend deferrals also re-enqueue without consuming queue retries,
falling back to queue retry if enqueue fails. Jobs expire 24 hours after their
first deferral and leave the ready reading unchanged. Unknown
charges remain held in the spend authority. A duplicate of an uncertain dispatch
leaves the ready judgement alone;
a later scan with a newer run identity may try again. This deliberately favors
avoiding duplicate charges over retrying a job whose provider outcome is unknown.

Successful results save only a relationship patch, resulting-manifest hash, and
the neighbour manifest versions used as input. Those versions must still match
before dispatch, result storage, and manifest publication, including checkpoint
replay. An already committed manifest may still repair its list verdict after a
neighbour changes.
Publication CAS-writes `connections`, `novelty_verdict`,
`connections_computed_at`, and `connections_neighbourhood_ids`, preserving all
other manifest fields. The existing list CAS loop updates only the existing
row's novelty verdict and rechecks ownership after contention. A saved result
can repair a failed list write without another paid call. Lost manifest CAS,
reprocessing, purged inputs, and tenant suppression stop publication; errors
never create a failed reading. The checkpoint contains no article summary and
is removed by reading purge and the guarded account-teardown D1 batch.

The slice-4 single-night staging acceptance check passed on 2026-09-08. Both
environments start with a two-judgement nightly cap. Apply the migration through the
normal Worker release path before deploying the new consumer.

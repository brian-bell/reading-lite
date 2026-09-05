# Operating reading-lite

Deploying, ingesting in bulk, and repairing the corpus. `README.md` covers the
architecture and the HTTP API; this document is the operator runbook.

Operator workflows run through the unified plan-first CLI: `npm run ops --
<group> <command> [options]`. Every command with durable side effects prints a
plan by default and acts only with `--execute`.

### Operator Node

`npm run ops` is supported on **Node 20.19.x** (`/usr/bin/node` on Debian).
That is the supported operator path. Do not upgrade the operator laptop to
Node 22 — it will not launch under the security boundary Snipe runs in.

Wrangler 4.87+ hard-fails in `bin/wrangler.js` on Node < 22. Ops does not
spawn that wrapper: it execs `node_modules/wrangler/wrangler-dist/cli.js`
with the current Node (see `scripts/lib/wrangler-cli.ts`). Corpus, deploy,
staging, and founder commands therefore run on 20.19.x. Wrangler may print
a Node 22 warning on the banner; that is wrangler's advertised floor, not a
reading-lite failure. CI remains Node 22. The production Worker stays on
workerd.

`package.json` `engines.node` is `>=20.19.0` so npm does not reject Node 20.

Every `corpus` command additionally requires `--tenant <selector>` before it
plans anything. There is no default — a missing or malformed selector is a
usage error (exit 2) before any R2 or Vectorize traffic, so an operator can
never act on the wrong corpus by omission.

A `usr_…` tenant id addresses that tenant's `u/{tenantId}/` key namespace plus
its Vectorize namespace (the same roots the worker derives from a validated
`TenantContext`). `global` is the pre-tenant layout selector: local (where
`TENANT_DATA_PLANE` is still unset), migrate-founder source and rollback, and
the leftover global objects both deployed environments retain — production's
pending signed-off deletion, staging's kept by its own copy-only migration.
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
  https://reading-lite.bbell.dev/api/whoami
# Record tenant_id as TENANT (usr_…). Expect tenant_data_plane true.
```

Then `--tenant "$TENANT"`.

**Account deletion.** `DELETE /api/account` (195a) marks the caller `deleting`
and revokes credentials. Production `TENANT_DATA_PLANE=1`: the founder is a
normal tenant. Deleting that account suppresses the founder corpus the same
way as any other — there is no silent founder exception. After a 7-day grace
(`deleting_at_ms`), the shared `ACCOUNT_WIPE_JOBS` queue plus the existing
*/15 cron sweep delete the tenant R2 prefix and submit Vectorize `deleteByIds`
(async: embeddings may take a short time to disappear). A job payload
`{ force: true }` skips grace to start a new wipe. Cron resumes in-progress
or leftover wipes during grace and preserves `force` from the wipe record.
Wipe is not inline in `DELETE /api/account`.

Wipe state lives in D1, in the `wipe_progress` table (migration `0009`), one row
per tenant: phase, the two cursors, lease, probe and continuation bookkeeping,
and the completion record. Every write is a conditional
`UPDATE … WHERE tenant_id = ? AND lease_seq = ?` that bumps `lease_seq`, so a
delivery whose row moved under it changes zero rows, logs
`account_wipe_lease_held`, and **acks** — the winner is already doing the work,
and a retry would only lose the same CAS again. The consumer runs at
`max_concurrency = 1`, so this is a backstop against at-least-once redelivery
and cron overlap rather than the primary serialization.

Because the lease is a version rather than a timestamp, `updated_at_ms` is
advice: cron uses it to avoid enqueuing a duplicate it would have to turn away,
and nothing is lost if it is wrong in either direction. Two things that used to
need care therefore no longer do — a job running on a frozen clock, and a wipe
owed a long `Retry-After` (up to 12h). Cron may take either one over; the
displaced delivery reports `lease_held` and stands down.

The completion record is **kept**, not deleted, and it is two pairs.
`completed_at_ms` / `residue` are the current state: this wipe has nothing left
to do. A reopen clears them, which is what a teardown gate wants — it must not
hard-delete the users row while a reopened pass is still running.
`first_completed_at_ms` / `first_residue` are the durable history, written once
at the first terminal transition and pinned in SQL so nothing can move them; the
residue scan reads those. Without the second pair, a reopen whose enqueue failed
or whose pass dead-lettered would leave the row claiming the tenant had never
been wiped at all.

`residue` says whether the namespace was ever confirmed clean — read
`probe_saw_residue` beside it to tell "vectors were still there" from "we never
got an answer" — and the terminal write clears both cursors so nothing reading-
shaped survives on a deleted account's row. The foreign key to `users(id)`
deliberately does **not** cascade: the later control-plane teardown hard-deletes
the users row and gates that on reading this record, so a cascade would destroy
the evidence at the moment it is needed. Teardown removes the row explicitly,
after the gate has been read.

Heartbeats are throttled to `ACCOUNT_WIPE_HEARTBEAT_INTERVAL_MS` (one minute, a
fifteen-fold margin under the advisory lease window) rather than firing on every
R2 page and vector batch, which cost hundreds of full-row D1 writes per delivery
on a large tenant. Anything a later delivery depends on — the lease claim, phase
transitions, a `continue`'s cursor and continuation count, probe bookkeeping and
the terminal record — is written unconditionally regardless of the throttle.

A wipe that keeps making a little progress and then failing used to cycle
forever: each `continue` acks and self-sends, which starts a fresh queue retry
budget. `continuations` on the record counts those self-sends per pass and
`ACCOUNT_WIPE_MAX_CONTINUATIONS` bounds them (sized at roughly four million
objects or ids — far past any real tenant). Past the bound the job throws
instead of self-sending, so the delivery retries normally and dead-letters where
it can be seen. Reopening a leftover wipe resets the counter.

A tenant left `status='deleting'` with a NULL `deleting_at_ms` can never elapse
grace, so its wipe would never start. Both fan-out and the job log
`account_wipe_missing_deleting_at` for that row rather than stalling silently;
recover it by repairing `deleting_at_ms` or by forcing the wipe.

The wipe has two phases, vectors then objects. It does **not** re-submit
`deleteByIds` after the prefix is empty, and does not persist reading ids on the
progress record. The late-publish race that re-submit covered — a
`processReading` that passed its tenant check before the wipe collected ids and
upserts a vector afterwards — is handled at the publisher instead: a consumer
publishing against a tenant confirmed `deleting` deletes its own vector directly
(`ReadingVisibility.removeForDeletedTenant`) rather than waiting on an
`index/list.json` row the wipe has already removed.

**Deploy note, one time only:** progress moved from
`wipe/{tenantId}/progress.json` to D1, and the new code never reads the R2
object. A wipe in flight when the new Worker rolls out therefore restarts from
scratch — a fresh row, `phase:"vectors"`, cursors clear. That is safe (every
phase is idempotent: re-listing the prefix and re-submitting `deleteByIds` for
ids still derivable from R2 costs work, not correctness), but a restarted pass
re-derives ids from whatever R2 holds *now*, so a tenant whose objects the
interrupted pass had already deleted contributes fewer ids on the retry and can
raise a `account_wipe_namespace_residue` that reflects the deploy rather than a
real finding. Confirm `reading-lite-wipe` and `reading-lite-wipe-dlq` are empty
and no tenant is `status='deleting'` before merging, exactly as the S1 deploy
did, and treat one residue alert in that window as suspect. That precondition is
a human step — nothing in the deploy workflow enforces it. Making the workflow
refuse to deploy while a wipe is in flight is issue #269.

The stale R2 objects left behind by an interrupted wipe are inert but not
self-clearing: nothing reads or deletes `wipe/{tenantId}/progress.json` any
more. If any exist after the rollout, delete them by hand — the key names a
deleted tenant, which is why the old code deleted it on completion.

Rollback is the awkward direction, and worse than S1's: the previous Worker
reads only R2, so it would see no progress record and start a fresh wipe from
`vectors` while the D1 row still says otherwise. The D1 table is additive and
harmless if the code is reverted, but a wipe in flight across a rollback is
duplicated work with no shared lease. Roll back with the queue drained, or
force-complete the tenant afterwards. As always, `TENANT_DATA_PLANE` off is the
kill switch that short-circuits the whole path.

**That fence is no longer load-bearing.** It still runs, and it still deletes
promptly rather than leaving the work to a later pass — but its two escape
hatches (a D1 recheck that fails open, an isolate that dies between the upsert
and the recheck) no longer strand anything. Since issue #195 slice S3 every
vector writer records the reading id in D1 `vector_ledger` **before** it
upserts, so the id survives the deletion of the reading's R2 objects and the
wipe can still address the vector.

Cron decides what to do from the record rather than from R2 state: no row means
never wiped (grace gates the start), a row with no `completed_at_ms` means a
wipe still owed work (the advisory lease decides whether to enqueue), and a
completed row means done — reopened only if objects turn up under the prefix
again. That retires the old "no record AND an empty prefix" probe, which could
not tell an already-wiped tenant from one whose prefix was emptied while vectors
stranded, and so had to skip both forever.

**What remains a gap is the past, not the future — and one half of it is a
gate on #195, not a footnote.**

A reading purged from R2 before slice S3, whose vector delete failed, has no
ledger row and cannot be given one: there is nothing left to derive an id from.
`ops corpus seed-vector-ledger` covers every reading an existing corpus still
*has*; a vector already orphaned when the ledger arrived is unseedable by
construction.

The other half is recoverable and must be recovered. Until S3, the offline batch
pipeline wrote tenant vectors under **bare** reading ids — `makeVectorizeClient`
attaches a namespace but never composed the tenant-scoped id. Any tenant that
has ever run `ops corpus ingest` or `ops corpus recover --batch` under
`--tenant` therefore holds vectors this wipe cannot address, because
`deleteByIds` submits the composed id and misses them. Every wipe for such a
tenant spends its attempts, alerts, and completes with `residue = 1` while those
embeddings survive account deletion indefinitely.

**So `residue = 1` on such a tenant is not a clean-enough outcome to file away.**
It is that known gap. Repairing it in production is a gate on #195's acceptance
bullet 3 ("a repeatable residue scan reports zero tenant-owned data"), and slice
S5 owns the audit and the repair. `probe_saw_residue` beside `residue` still
separates "vectors were still there" from "we never got an answer".

That population costs something on a *live* tenant too, which is worth knowing
before anyone dismisses it as a deletion-only concern: a bare-id vector and a
composed one for the same reading are two distinct matches to a namespaced
query, so the reading appears twice in its own neighbourhood and duplicates land
in `manifest.similarity` — inflating `count`, skewing `mean`, and spending a
neighbour slot.

**The batch writer deliberately does not fix this by deleting the bare id.**
Vectorize ids are index-unique and `delete_by_ids` is namespace-blind, so for a
reading the pipeline has never touched, deleting `rd_…` removes the *legacy
pre-cutover* vector — the retained `TENANT_DATA_PLANE` rollback set that a
tenant-scoped operation is not meant to reach, and whose deletion needs its own
sign-off. A routine `corpus ingest --tenant "$TENANT" --execute` would have
eroded it silently. Telling the two apart is possible (a legacy vector is
un-namespaced; a batch-written duplicate carries the namespace, and `getByIds`
reports it), but that is a destructive production behaviour that belongs with
the sign-off, not inside an unrelated slice.

S5's audit therefore owns both halves: the wipe residue and the search
duplication.

### Account residue scan and bare-vector repair (S5)

These commands implement the local operator surface for [#195](https://github.com/brian-bell/reading-lite/issues/195)
and design [#263](https://github.com/brian-bell/reading-lite/issues/263).
Code completion does not close either acceptance gate: staging proof and the
production audit/repair are separate, approved operator work. No production
read-only check or repair was performed while implementing these commands.

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
and 0 only when all scanned sources are clear or expected. Currently the CLI
cannot independently inspect TenantUsageGuard storage/alarms or GlobalUsageGuard
leases: the bound DOs have purge handlers but no operator read surface. Those
are explicitly unknown, so a scan can report zero observed data and still exit
1. Teardown's fail-closed DO purge is useful evidence, not a direct inspection.
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

### The wipe seeds its own ledger

**No operator step is required before a wipe.** From issue #195 slice S3 the
wipe submits `deleteByIds` only for ids the ledger names — and a corpus that
predates the ledger has none — so before any phase runs it pages its own key
root, derives every reading id from the object keys, and inserts the rows it is
missing. R2 is intact at that moment (it is what the wipe is about to delete),
so the job holds exactly the inputs the seeding command would.

The invariant that buys: **no object is deleted before its reading id is in the
ledger.** Nothing to remember, nothing to enforce.

The seed step is insert-only — a row an earlier pass moved to
`delete_submitted` keeps its state, delete stamp and absent streak — resumable
on `wipe_progress.seed_cursor`, and it logs its work:

```
account_wipe_ledger_seeded  rows_created 0   outcome done
```

A **nonzero** `rows_created` on a tenant you believe was already seeded means
the ledger was incomplete. Expected on a corpus predating S3; worth
investigating on one that should have been covered by the writers.

`ops corpus seed-vector-ledger` is still worth having — it lets you rehearse
the walk, and repair a **live** tenant's ledger without waiting for a deletion
— but it is no longer a prerequisite for anything:

```sh
npm run ops -- corpus seed-vector-ledger --tenant "$TENANT" --bucket reading-lite
npm run ops -- corpus seed-vector-ledger --tenant "$TENANT" --bucket reading-lite --execute
```

The operator seeder now uses the same insert-only helper as the wipe: existing
state, delete timestamps, absent streaks and last-observation times are preserved,
even during an in-flight wipe. It reports actual rows inserted.

It over-seeds on purpose, exactly as the wipe's own step does: a row for a
reading with no vector costs one no-op `deleteByIds` and then clears, while a
missing row is unrecoverable. `--tenant global` is refused — the pre-tenant
corpus has no tenant id to key rows by and no account wipe addresses it.

The completion record is what the users-row hard-delete gates on: read
`completed_at_ms` and `residue` from `wipe_progress`, never an inference from R2
state. Gate on `completed_at_ms` (current state, so a reopened wipe holds the
gate shut); report history and residue from `first_completed_at_ms` /
`first_residue`, which no reopen can erase.

**Control-plane teardown (S4).** Once a wipe has completed and the tenant prefix
is confirmed empty, the same */15 cron fan-out runs
`src/control-plane/account-teardown.ts` for that tenant. It is its own stage,
not part of the wipe delivery, so a failure retries on the next tick instead of
dragging a finished wipe back through the queue. In order:

1. The **audit row** (`account_deletions`, migration `0011`) is written first,
   before anything destructive, so a crash part-way through still leaves durable
   evidence the deletion was attempted. It carries the tenant id, four
   timestamps (`deleting_at_ms`, `completed_at_ms`, `first_completed_at_ms`,
   `torn_down_at_ms`) and two flags (`residue`, `first_residue`) — no email, no
   display name, no reading ids — and it has no foreign key, because it has to
   outlive the `users` row it describes.
2. The tenant's `TenantUsageGuard` is emptied and its alarm cancelled, and that
   tenant's leases are cleared from the singleton `GlobalUsageGuard`. This step
   **fails closed**: a bound namespace that errors aborts teardown before any
   D1 delete, so the `users` row is never removed while guard state keyed to
   that tenant survives.
3. **The R2 prefix is rechecked** after those Durable Object purges and the
   address-history lookup, immediately before `db.batch`. A late publisher
   during those round-trips would otherwise leave an orphan no later tick can
   enumerate, because the hard delete removes the tenant from
   `listDeletingUsers`. Anything but a confirmed-empty verdict refuses the
   batch. Reached from fan-out the verdict is only ever `empty` or `not_empty`
   — the third state, "could not look", needs the data-plane gate off, and
   fan-out has already returned early in that case — so in practice a refusal
   means real leftovers, and the next `*/15` tick reopens the wipe for them. An
   R2 `list` that throws is the genuine could-not-look case: it propagates out
   of teardown and is logged as `account_teardown_failed`, leaving every row in
   place for the next tick.

   **This narrows the window; it does not close it.** An object can still land
   between the verdict resolving and the batch committing, and that one is
   orphaned by the same argument — the tenant is gone from `listDeletingUsers`
   and nothing enumerates it again. It is the same residual class as the
   late-publish race in the wipe itself, and it needs the same fix: the durable
   per-tenant vector/object provenance that issue #261 tracks. Do not read this
   step as a guarantee that no orphan can occur.
4. Every tenant-keyed D1 row goes in one batch, children before parents:
   `api_token_scopes`, `api_tokens`, `sessions`, `auth_challenges`,
   `digest_deliveries`, `user_settings`, `tenant_limits`, the account's
   `signup_invites` rows (see below), `wipe_progress`, and finally `users`.
   D1 enforces foreign keys by default; no migration declares
   `ON DELETE CASCADE`. Child rows therefore go first, and `wipe_progress` is
   deleted explicitly after its gate has been read. Unconfirmed `vector_ledger`
   rows are retained for residue repair. Migration `0012` removes their users
   foreign key while preserving all rows, columns, other constraints and the
   index, so those repair handles can outlive the account. The table rebuild
   runs transactionally before Worker upload; existing ledger writers remain
   compatible.

**Teardown runs wherever the tenant data plane is on.** Fan-out still returns
early when `TENANT_DATA_PLANE` is unset (local), because there is no tenant
prefix to confirm empty. Staging pins the gate in `[env.staging.vars]` (issue
#203 / slice S6), so a staging account whose wipe has completed is torn down
on the next `*/15` tick — the same path production uses, and that includes the
S6 completed-wipe fixture, which is exempt from nothing: see "Rehearsing
account deletion on staging". Residue scan remains slice S5.

Teardown runs on a `residue = 1` wipe too. A wipe that finished without
confirming the namespace clean is still finished; the flag is copied onto the
audit row for the residue scan and for support, rather than pinning the account
open forever. `AuthRateGuard` is deliberately untouched — it is a singleton of
hashed, TTL-windowed email/IP counters with no tenant key to purge by.

**Email reuse, and the invite trap.** Until teardown runs, the address is not
reusable: the `users` row is still present and not active, so
`resolveLoginEligibility` answers `ineligible`. After teardown the row is gone
and the address is free.

Under `signup_mode = 'invite_only'`, though, free means free to be *invited*.
Teardown deletes the account's own consumed invite along with everything else,
so **a re-signup at that address needs a fresh invite**. This is deliberate —
leaving a consumed invite behind would give a deleted account's address a
standing claim on a closed system — but it will surprise you if you are trying
to help someone back in.

Teardown frees **every address the account ever used**, not only its last.
Addresses come from the account's own `auth_challenges` rows, which are the only
link back once an email change has overwritten `users`. Two rules keep that off
other people's data, and both matter:

- Only *proven* addresses are collected — one from a redeemed challenge, or from
  a login challenge (whose `user_id` is set only for a user who already owns the
  address). Never the address a pending `email_change` merely names: nothing
  verifies those until redemption, so collecting them would let any account name
  a stranger's address and have teardown act on it.
- Of those, only *consumed* invites are deleted, plus any invite on the
  account's current address. An **unconsumed** invite on a previously released
  address is left alone: it is a pending grant belonging to whoever has been
  invited there since. A *consumed* one on a released address is deleted, and
  that row may in principle be a third party's — someone invited to the address
  after this account released it, who has since signed up. It is a spent marker
  with no further effect (`resolveLoginEligibility` finds their `users` row and
  never reads the invite), so this is recorded as known and inert rather than
  claimed to be impossible. Making it impossible needs an owner column on
  `signup_invites`, which no slice has needed yet.

One residue in `auth_challenges` is known and deliberate for the same reason: a
login challenge issued and then superseded at signup, on an address the account
later changed away from, has no owner recorded on it at all and is not reached.
It could only be swept by address, and on a released address such a row may
equally belong to somebody signing up there now — deleting theirs would be the
worse error. Closing it needs a durable owner link the schema does not have.

**Timing, if you are re-inviting the account's own address.** Teardown deletes
an invite row when it is already *consumed*, or when it names the account's
**current** address — consumed or not. So a fresh invite issued for that address
while the account is still `deleting` is swept by the teardown tick that
follows, silently, leaving you believing the address is invited when it is not.
Wait until the `users` row is actually gone, and check that directly:

```sql
SELECT 1 FROM users WHERE id = '<tenant>';   -- must return nothing
```

An `account_deletions` row is **not** the check. It is written before the
destructive batch and survives a batch that matches nothing, so it proves
teardown was *attempted*, not that it succeeded. The
`account_teardown_complete` log is a better signal but is not durable
evidence. The absence of the `users` row is.

The separately executed
[2026-09-05 staging email-reuse drill](evidence/286-staging-email-reuse-2026-09-05.md)
records signup-shaped reuse after automatic teardown (issue #286), including
the invite trap while `status=deleting`.

A *previously released* address is the opposite case and needs no waiting — an
unconsumed invite there survives teardown, because it belongs to whoever has
been invited since, not to the account being deleted.

Issue a new invite with:

```sql
INSERT INTO signup_invites (email_canonical, email_display, created_at_ms)
VALUES (?, ?, ?);
```

A future operator row will add a scripted, verified sweep of the `wipe/` prefix
for the stale R2 objects described in the deploy note above; until it exists,
that cleanup is the manual step named there.

Before reporting success the wipe probes the tenant's Vectorize namespace and
refuses to finish while anything still answers, logging
`account_wipe_vector_count_delta` with the `describe()` count either side. Read
that as evidence, not proof: Vectorize offers no list or scan at any scope, so a
nearest-K probe samples the namespace and cannot demonstrate absence.

A probe hit retries on a deliberately slow schedule
(`ACCOUNT_WIPE_PROBE_RETRY_DELAY_SECONDS`, minutes rather than the 30s
exponential): `deleteByIds` propagates asynchronously, so the first probe after
submitting is expected to be dirty, and the fast schedule would dead-letter
every real wipe before propagation landed. A probe that *errors* takes the same
slow path rather than the fast one, so a transient Vectorize failure cannot
dead-letter an otherwise finished wipe. Those retries are bounded by
`ACCOUNT_WIPE_PROBE_MAX_ATTEMPTS`, held equal to the wipe consumer's
`max_retries` so the whole bound is spent inside one message's own retry budget
and a probe hit never reaches the dead-letter queue — a unit test pins the two
together, because raising one without the other makes every healthy wipe DLQ
before the bound trips. **Known gap:** a vector whose reading id was
already missing from R2 before the wipe started is not addressable at all —
`deleteByIds` needs the id and nothing remains to derive one from — so no number
of retries can clear it. On exhausting the bound the wipe therefore logs a
high-severity `account_wipe_namespace_residue` alert (tenant id only, never
reading ids) and **completes** rather than looping through the DLQ and cron
forever. Treat that alert as "this account's wipe left residue an operator must
know about", and note the same vector ledger is what makes it fixable. An
unbound `READINGS_INDEX` fails the job even when no ids were collected, so a
wipe can no longer report success without having addressed the index at all.

**Sweeping the `wipe/` prefix.** Slice S2 of issue #195 (#270) moved wipe
progress out of R2 and into D1, and deleted the only code that ever removed
`wipe/{tenantId}/progress.json`. Any record a wipe in flight at the moment of
**that deploy** left behind is a permanent orphan: a bucket key naming a deleted
tenant, with a body carrying that tenant's `vector_cursor` (a reading id).
Merged is not deployed — the rollout sequence below turns on that distinction.
Clear the orphans with

```sh
npm run ops -- account sweep-wipe-prefix    # plan: list only
npm run ops -- account sweep-wipe-prefix --execute --acknowledge-no-active-wipe
```

Rollout sequence, in order:

1. **Start in plan mode.** It lists every object under `wipe/` with size and
   last-modified time and writes nothing. Empty is the easy case; anything
   listed is a wipe you want finished, not interrupted. (S2 has merged, so in
   practice this step and the next collapse into "confirm the deploy landed,
   then plan" — the ordering below is what matters, not the merge.)
2. **Confirm S2 is deployed. That is the precondition**, and the only thing that
   makes these records safe to delete: once the new Worker is live, nothing
   reads or writes `wipe/` at all, so every record under it is orphaned by
   construction. `--execute` refuses to run without
   `--acknowledge-no-active-wipe`, which is your assertion that the deploy has
   landed.

   **Before S2 deploys, any record under `wipe/` means that tenant's wipe is
   running or due — wait for it, do not sweep around it.** A fresh record is
   being written right now; one more than 15 minutes stale has a lapsed lease
   (`wipeLeaseHeld` in `src/account-wipe.ts` goes false at
   `ACCOUNT_WIPE_IN_FLIGHT_MS`, one cron interval), which is exactly when the
   fan-out may enqueue a *resume*. Stale means due to be picked up, not finished
   with. Deleting either costs that wipe its cursor (the next progress write is
   a compare-and-set on the etag it read) and restarts it from a full id
   re-collect.

   **After S2 deploys, the in-flight signal lives in D1**, not in R2: a
   `wipe_progress` row with `completed_at_ms` NULL and a recent `updated_at_ms`
   heartbeat is a wipe still running. Plan mode prints that query scoped to the
   tenants its records name, against the control plane matching `--bucket`.

   **A `users.status` count is not the signal, before or after.** `status` stays
   `deleting` after a wipe *completes*, until the S4 teardown hard-deletes the
   row on a later cron tick. A count of `deleting` users therefore lags the
   actual state in both directions — it is non-zero for a tenant whose wipe has
   already finished, and it drops to zero the moment teardown runs, which says
   nothing about whether a *different* tenant's wipe is in flight.
3. Then run the sweep with `--execute`. It deletes the listed objects, re-lists
   the prefix, and **exits non-zero if anything remains** — so a green exit is
   evidence the prefix is empty, not just that the deletes were submitted. It is
   not evidence the run was harmless: R2 has no conditional delete, so a record
   written between the listing and its delete would be destroyed and then absent
   from the re-list. That the sweep harmed nothing rests on step 2's deploy, not
   on the verification.
   On a non-zero exit read which half of the report it is. Keys that *survived
   the delete* (same key, same etag) are safe to re-run against. Keys marked
   *NEW or REWRITTEN since the plan listing* — a new key, or the same key with a
   different etag — were written after the listing the run planned against,
   which should be impossible once S2 has deployed. Check `wipe_progress` for an
   unfinished row before touching them; a live wipe's record must not be
   deleted. A key the guard refuses outright has no override: inspect it and
   remove it by hand (`npx wrangler r2 object delete <bucket>/<key> --remote`).

Deletes are hard-restricted to keys literally under `wipe/`. A tenant-rooted key
(`u/{tenantId}/…`) or a legacy pre-cutover corpus key (`readings/`, `index/`)
is refused, and a listing containing one aborts the run before any delete. The
command takes no `--tenant`: these keys sit outside every tenant key root, and
the sweep clears the prefix as a whole. Default `--bucket` is production
`reading-lite`.

Users-row hard-delete, Durable Object teardown, and email reuse live in
`src/control-plane/account-teardown.ts` (issue 195 S4). Residue scan is the
remaining later slice (S5). `DELETE /api/readings/:id` remains one-reading
purge inside a live tenant.

One caveat: `corpus recover`'s realtime path writes through the Reading API,
where the acting tenant is the **bearer token's** principal, not `--tenant`.
Before submitting, a realtime `--execute` therefore asks the worker who the
token is (authenticated `GET /api/whoami`, which also reports whether the
tenant data-plane gate is on) and fails closed on any mismatch: a `usr_…`
selector requires the gate on and the token's tenant equal to the selector;
`global` requires the gate off (with it on, every API write lands in the
token's tenant namespace, never the global layout). The verified layout is
then pinned onto every write via the `x-expected-tenant` header, which the
worker checks atomically per request — so a gate flip or rolling deploy
mid-run rejects later writes (412) instead of silently re-routing them. (The
pin protects only once every serving worker version enforces it: never flip
`TENANT_DATA_PLANE` in the same deploy that ships the pin — automatic under
the s1k.6 sequencing, where the flip comes well after.)
`--batch` is scoped by `--tenant` end to end and needs no verification.
(reading-lite-1xk)

## Environments

| Environment | Worker | Bucket / Vectorize index | Notes |
|---|---|---|---|
| local | `reading-lite-dev` | Miniflare-emulated R2 only | no Queue, no Vectorize |
| staging | `reading-lite-staging` | `reading-lite-staging` | same-origin `reading-lite-staging.bbell.dev` (Pages + `/api/*` `/health` `/mcp*`) |
| production | `reading-lite` | `reading-lite` | routed at `reading-lite.bbell.dev/api/*` + `/health` + `/mcp*` |

Environments do **not** inherit top-level `[vars]` or bindings — `wrangler.toml`
repeats them per environment. The distinct dev Worker name guards against an
accidental bare `wrangler deploy` clobbering production.

`TENANT_DATA_PLANE=1` prefixes hosted R2 keys as `u/{tenantId}/…`. Production
pins it in `[env.production.vars]` since the founder cutover (2026-08-31,
`docs/founder-cutover.md`); staging pins it too, so the destructive
account-wipe path can be rehearsed there ("Rehearsing account deletion on
staging"). Only local stays unset. After either pin, new writes land only
under tenant R2/Vectorize — rolling the gate back is a complete rollback only
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
| `AUTH_ROOT_SECRET` | always — 256-bit hex HKDF root for credential HMACs |
| `AUTH_PREVIOUS_ROOT_SECRET` | optional — previous root during a bounded rotation window |
| `OPENAI_API_KEY` | always — embeddings, and the default OpenAI summarizer |
| `ANTHROPIC_API_KEY` | only when `SUMMARIZER_PROVIDER=anthropic` |
| `X_API_BEARER_TOKEN` | only for `x.com` / `twitter.com` status URL imports |
| `RESEND_API_KEY` | required on staging/production — magic-link auth mail and per-reading notifications (recipient is `users.email_display`, never `EMAIL_TO`) |
| `TURNSTILE_SECRET_KEY` | required to send open-mode magic-link mail on staging/production — Cloudflare siteverify secret (**never** in `[vars]`). Local skip/fail-open when unset; staging/production fail-closed (missing secret, siteverify errors, or `success ≠ true` → no-send `{ok:true}`) |

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
`to` is the current verified `users.email_display` — `EMAIL_TO` is never a
fallback. Import is always silent even if the body or `--email` is true.
`notify_immediate=0`, `email: false`, a missing settings row, an inactive or
unverified user, an empty `EMAIL_FROM`, or a staging `AUTH_MAIL_ALLOWLIST` miss
all skip send (no `send_email` event). Resend failures still log a failed
`send_email` event with recipients redacted; the reading stays `ready` and the
job is not requeued.

Scheduled digests also go through Resend to the current verified
`email_display` — never `EMAIL_TO`, independent of `notify_immediate`, and
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

Production is the same sequence with `reading-lite-control`, `--env production`,
`.prd.vars`, and:

```sh
npm run ops -- founder bootstrap --email founder@example.com --env production \
  --execute --confirm-production
npm run ops -- deploy worker --env production --execute
npm run ops -- deploy web --branch main --execute
```

Merges to `main` start one coordinated production chain. After `.github/workflows/ci.yml`
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

GitHub repository secrets (or the `production` environment):

| Secret | Purpose |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Non-interactive Wrangler. Grant Pages Edit for the SPA workflow. The Worker workflow also needs Workers Scripts Edit, D1 Edit, and zone Workers Routes on **both** `bbell.dev` and `bbookmarks.com` so migrations apply and the route updates succeed (see "bbookmarks.com dual-serve" below). Scope the token to this account and those zones. |
| `CLOUDFLARE_ACCOUNT_ID` | Account Wrangler deploys into. |

The imported founder token expires after 90 days; re-running the same
bootstrap command refreshes `expires_at_ms` and clears a revoked row.

When a release adds an API scope (e.g. `readings:delete`, migration
`0002_readings_delete_scope.sql`), existing tokens do not pick it up on their
own: `ops deploy worker --execute` applies the migration, then re-run the
same founder bootstrap command — its scope grants are idempotent and top up
the existing token.

`ops deploy worker` targets only staging and production (`--env`), so a dev
Worker can never be uploaded by mistake. `ops deploy web --skip-build` reuses
an existing SPA build.

Local `npm run dev` runs `dev:setup` first (local D1 migrations + founder
bootstrap of `dev-local-token`).

The SPA is served from Cloudflare Pages on the same custom domain as the Worker;
Worker routes are scoped to `/api/*`, `/health`, and `/mcp*` so Pages handles every other
path. Pages uses `web/public/_redirects` (`/* /index.html 200`) so `/auth/verify`
does not 404. Staging uses `https://reading-lite-staging.bbell.dev` the same way
production uses `https://reading-lite.bbell.dev`. Magic-link mail is built from
`WEB_BASE_URL` (`https://reading-lite-staging.bbell.dev/` on staging).

### bbookmarks.com dual-serve

Production serves two hosts during the domain migration. `[env.production.routes]`
in `wrangler.toml` carries the original `reading-lite.bbell.dev` trio (`/api/*`,
`/health`, `/mcp*`) **and** the same trio on `bbookmarks.com` (`zone_name =
"bbookmarks.com"`). Both hit the same Worker script, R2 bucket, D1 database and
Vectorize index, and nothing in the data plane depends on the hostname, so the
`/api/*` read and write paths and `/health` are interchangeable between the two
hosts. The exceptions are anything that *emits a link* — `/api/auth/*` magic-link
mail is built from `WEB_BASE_URL`, still the old host, so a sign-in started on
the new host is mailed back to the old one. `/mcp*` is not interchangeable
either — nor is the `/api/mcp` alias the section below offers as a fallback,
which sits behind the same guard: `mcpOriginGuard` 403s any `Origin` outside `MCP_ALLOWED_ORIGINS`, which
still lists only the old host, so browser-origin MCP calls to the new host are
rejected until that allowlist follow-up lands (non-browser clients send no
`Origin` and work on either host). Browser sessions are host-scoped too — the
session cookie carries no `Domain` attribute — so signing in on one host does
not sign you in on the other. The old routes stay until the old host is
formally retired; they are the rollback path.

`www.bbookmarks.com` is **not** a Worker route, and must not become one. `www` →
apex belongs to a Cloudflare Redirect Rule (301), which fires before a request
ever reaches the Worker. As of 2026-09-04 `www` has no record at all and returns
NXDOMAIN; proxying the apex does not change that, since a Pages custom domain
creates a record only for the hostname it is bound to. So `www` stays
unreachable — not wrongly served — until it is given its own proxied record and
the redirect rule.

Three things to settle outside this repo — the first two before the routes can
deploy, the third only if `www` is to resolve:

- `CLOUDFLARE_API_TOKEN` (GitHub secret and any local ops token) must include
  zone Workers Routes on `bbookmarks.com`, keeping `bbell.dev`. **Until it does,
  `ops deploy worker --env production` applies the remote D1 migrations, uploads
  the script, and then fails on the route publish** — the same footgun described
  under "MCP connector" below, now on a second zone. It surfaces two ways
  depending on what the token holds: with Zone Read but no Workers Routes edit,
  authentication error 10000 on `/zones/.../workers/routes`; with no grant on
  the zone at all (the likely state for a newly added zone) the zone lookup
  returns nothing and wrangler fails with `Could not find zone for
  bbookmarks.com`. That lookup is filtered by `CLOUDFLARE_ACCOUNT_ID`, so a zone
  registered under a *different* Cloudflare account fails with the same message
  even on a correctly scoped token — check the account before chasing scopes. A third variant has nothing to do with the token: if one of
  these patterns is already bound to a different Worker in that zone, the
  publish fails with `Can't deploy routes that are assigned to another worker`.
  Mind what any of them leaves behind: the migrations and the new
  Worker script **have** landed and are live on the existing
  `reading-lite.bbell.dev` routes; only the route addition fails. And because
  `deploy-worker.yml` then exits non-zero, `deploy-spa.yml` — which runs only on
  a successful Worker run — never deploys, so production Worker code sits ahead
  of the production SPA until someone notices. Re-scope the token before merging
  anything that adds these routes. Recovering by re-running the failed workflow
  works only while `main` is still at that commit: both deploy workflows
  re-check `origin/main` against the run's `head_sha` and refuse a stale
  release, so once another merge lands, let the newer commit's chain deploy
  instead. Note the same token scoping bites at retirement, in the other
  direction: on a zone-scoped token wrangler uses the per-zone route API, which
  only adds routes and never deletes stale ones, so **removing the `bbell.dev`
  routes from this file will not remove them from Cloudflare** — delete them in
  the dashboard when the old host is retired.
- `bbookmarks.com` must be a Pages custom domain on project `reading-lite`, bound
  to the `main` branch, with an Active certificate. This is an ordering
  prerequisite, not a cosmetic one: a Worker route only receives traffic for a
  hostname that has a proxied DNS record in the zone, and the Pages custom-domain
  binding is what creates that record at the apex. While the apex has no proxied
  record — its state as of 2026-09-04, when it resolved to no A, AAAA or CNAME —
  the routes are simply inert and the new host serves neither SPA nor API. Note
  the flip side: if the apex is ever proxied to something else first (a parked
  page, another site or Worker), these routes take `/api/*`, `/health` and
  `/mcp*` on that hostname from the next production deploy, before any
  deliberate cutover. Check the apex before deploying if that may have changed.
- `www.bbookmarks.com` needs a proxied record plus the `www` → apex Redirect
  Rule, if `www` is to resolve at all. Nothing in this repo configures it, and
  no Worker route should: the 301 is meant to happen ahead of the Worker.

`WEB_BASE_URL`, `EMAIL_FROM` and `MCP_ALLOWED_ORIGINS` are unchanged by the route
addition: emitted links and the MCP Origin allowlist still name
`reading-lite.bbell.dev` until their own cutover steps land.

### MCP connector

`POST /mcp` is a Streamable HTTP MCP endpoint on the Worker. Cursor and Grok Bot
add it as a remote connector with a static `Authorization: Bearer <token>`
header (the same token as `reading-lite.bearerToken` / founder bootstrap).
There is no OAuth. Tools call the existing `/api/readings*` routes internally;
the token is never echoed in tool results.

Production needs the dedicated `reading-lite.bbell.dev/mcp*` Worker route so
Pages does not serve SPA HTML at `/mcp`. Attaching that route requires zone
Workers Routes permission on the Cloudflare API token; if `ops deploy worker
--env production` uploads the script but fails with authentication error 10000
on `/zones/.../workers/routes`, add the route in the dashboard (Worker
`reading-lite`, pattern `reading-lite.bbell.dev/mcp*`) or use the `/api/mcp`
alias which is already covered by `/api/*`. Staging has the same trio of
Worker routes on `reading-lite-staging.bbell.dev` (`/api/*`, `/health`, `/mcp*`).

`MCP_ALLOWED_ORIGINS` (wrangler var, default `https://reading-lite.bbell.dev`)
is the Origin allowlist. Requests with no `Origin` pass (non-browser clients).
Unknown Origins are 403.

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
idempotent — "already exists" on setup and "already gone" on teardown are
treated as success, while unexpected Wrangler or R2 API failures stop the run.

```sh
npm run ops -- staging setup --execute
npm run ops -- staging teardown --execute
```

Teardown removes Queue consumers before deleting the Worker, then deletes the
reading and digest Queue/DLQ pairs and Vectorize index, empties the bucket via
the S3-compatible R2 API, and deletes the bucket. The bucket-empty step needs
the `CORPUS_R2_*` credentials above. `ops staging setup` also creates
`reading-lite-staging-digest` and `reading-lite-staging-digest-dlq`.

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
a protected unnamespaced control. Keep that control intact. This implementation
adds deterministic local tests. The separately executed
[2026-09-05 staging drill](evidence/195-staging-drill-2026-09-05.md) records
the live repair, deletion, and automatic teardown evidence, including the
final `residue:false, incomplete:true` scan and remaining acceptance limits.
Signup-shaped email reuse after teardown is recorded in the
[2026-09-05 staging email-reuse drill](evidence/286-staging-email-reuse-2026-09-05.md).


`src/account-wipe.ts` skips with `no_tenant_prefix` whenever `TENANT_DATA_PLANE`
is off, so an environment with the gate unset cannot exercise the destructive
path at all. Staging therefore pins the gate in `[env.staging.vars]`, and its
pre-tenant corpus was migrated under `u/{founderTenantId}/` by
`ops corpus migrate-founder` first — that command copies rather than moves, so
the legacy `readings/` and `index/` objects are all still in the bucket.
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
will hard-delete the account** — every such tenant, with no exemption. The
`IS NULL` still covers a *reopened* wipe (a reopen clears `completed_at_ms`),
which is still live and does belong in the list. Completed empty-prefix tenants
are a separate question:

```sh
npx wrangler d1 execute CONTROL_PLANE --env staging --remote \
  --command "SELECT u.id, u.email_canonical, w.completed_at_ms, w.force \
             FROM users u JOIN wipe_progress w ON w.tenant_id = u.id \
             WHERE u.status = 'deleting' AND w.completed_at_ms IS NOT NULL"
```

`usr_5e6d0000-0000-4000-8000-000000000006` belongs in that second list, and it
is torn down automatically like any other completed wipe — see below.

Any account in either preflight result that is not meant to be destroyed —
the staging founder above all — needs an operator recovery decision before
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

Setting staging up this way once, from a checkout of the commit you want to
rehearse:

```sh
npm run ops -- corpus migrate-founder --tenant "$STG_TENANT" \
  --bucket reading-lite-staging --vectorize reading-lite-staging \
  --state ./founder-migration.staging.state.json --execute --sole-writer
# rerun without --execute until it reports fully migrated, then:
npm run ops -- deploy worker --env staging --execute
```

Pass an explicit `--state` path. The default `./founder-migration.state.json`
is stamped with the tenant, bucket and index it was created for, and a leftover
production or older staging state file in the cwd makes the command exit 1
("refusing to resume it as tenant …") in the middle of the cutover.

Hold the sole-writer pause across the deploy, and run one final plan pass
immediately before it. Any staging write that lands between the last migrate
pass and the gate flipping goes to the global layout and becomes invisible the
instant the Worker starts reading tenant-rooted. "Fully migrated" has to include
the **vector** re-upsert, not just the object copies: a namespaced query cannot
see a bare `rd_…` vector, so a corpus copied in R2 but not migrated in Vectorize
returns zero neighbours with no error anywhere.

The drill itself. Seed a throwaway tenant, fence it, let cron wipe it, then
prove the residue is gone.

Two id rules, both of which produce a rehearsal that looks perfect and proves
nothing if you get them wrong:

- **`$DRILL` is a fresh `usr_<uuid4>`, and it must be lowercase.**
  `parseTenantId` canonicalizes to lowercase (`src/control-plane/ids.ts`), but
  macOS `uuidgen` emits uppercase. An uppercase id still fans out, and then the
  wipe addresses `u/{lowercased}/` and writes `wipe_progress.tenant_id`
  lowercase — so the objects you seeded and every `WHERE tenant_id='$DRILL'`
  query below quietly miss.
- **Reading ids must use the Crockford alphabet `parseReadingId` accepts**
  (`src/services.ts` `ID_ALPHABET` — no `I`, `L`, `O`, `U`). An id outside it is
  skipped by `ops corpus seed-vector-ledger`'s walk, so the objects phase still
  deletes the reading's R2 objects but no ledger row and no `deleteByIds` ever
  exist for it. The vector is stranded, and surfaces at the end as residue — a
  synthetic reproduction of the issue #261 gap rather than a wipe bug.
- **You do not need to seed the drill tenant.** The wipe seeds its own ledger
  from the objects you write, before it deletes anything, so a drill that skips
  seeding is testing the real path rather than a rigged one. Watch for
  `account_wipe_ledger_seeded` with `rows_created` equal to the number of
  readings you seeded — that line is the wipe proving it found them.
- **Expect two wipe passes for a healthy tenant.** The first seeds and submits
  the deletes; the confirmation is not allowed to count an absence until 120s
  after `deleteByIds` returned, because propagation was measured at 30-90s and
  a probe inside that window carries no information. A single-pass completion
  means nothing was submitted — check `rows_created` before celebrating.

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

Prefer the real API (session cookie, `X-CSRF-Token`, recent-auth window —
the SPA Security page is the same path), then backdate grace so cron, not a
hand-injected queue message, starts the wipe:

```sh
# After DELETE /api/account with body { "confirm": "delete" }:
npx wrangler d1 execute CONTROL_PLANE --env staging --remote \
  --command "UPDATE users SET deleting_at_ms=<now - 8 days>, updated_at_ms=<now> \
             WHERE id='$DRILL' AND status='deleting'"
```

If you cannot call the API, this is the SQL that mirrors `beginAccountDeletion`
(status write, then the two revokes — `ACCOUNT_DELETE_REVOCATION_REASON` is
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

Expect one to three passes. Vectorize `deleteByIds` propagates asynchronously —
measured at 30–90 s on staging — while the terminal probe runs within seconds of
submitting it, so the usual first pass empties the R2 prefix, sees the namespace
still answering, records `probe_attempts = 1` / `probe_saw_residue = 1`, and
retries on the 300-second schedule; the next pass probes clean and writes
`completed_at_ms` / `first_completed_at_ms` with `residue = 0`. A fast delete can
probe clean on the first pass. Reading the result:

- **`probe_saw_residue = 1` is the normal outcome of a healthy wipe**, not a
  warning — it just records that some probe ran inside the propagation window,
  and nothing clears it once the wipe finishes clean.
- **`residue = 1` is the finding.** It means the wipe completed unconfirmed after
  `ACCOUNT_WIPE_PROBE_MAX_ATTEMPTS` (3), with a high-severity
  `account_wipe_namespace_residue` log line. `probe_saw_residue` beside it
  separates `outcome: "residue"` (a probe genuinely saw vectors) from
  `outcome: "unconfirmed"` (every probe threw — a Vectorize health question, not
  a finding about the account).

Residue checks afterwards.

**1. R2 under the tenant root — expect zero objects.** Do **not** use
`corpus audit` for this: it reads `index/list.json` first and hard-errors
("could not read index/list.json") when the object is missing, which is exactly
the state a successful wipe leaves behind. List the prefix directly instead,
with the repo's own R2 client rather than a hand-rolled `aws` invocation —
`r2InventoryClientFromVars` (`scripts/lib/cf-clients.ts`) is what
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

**2. Orphaned R2 wipe progress** (superseded by D1 in slice S2) — expect
0 objects:

```sh
npm run ops -- account sweep-wipe-prefix --bucket reading-lite-staging
```

3. **Vectorize** — a namespaced query against the tenant namespace must return
   no matches. That is the same signal `SimilarityStore.probeNamespace()` uses.
   Do not use whole-index `describe()` counts as evidence: they are served from
   replicas at different processing frontiers and go backwards, so `vectorCount`
   and `processedUpToMutation` both flap between values while the underlying
   per-id reads are correct.

4. **D1 after the wipe, before teardown** — the wipe still removes the
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
`DELETE FROM wipe_progress` / `DELETE FROM users` — that bypasses the audit
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

**The S6 completed-wipe fixture goes down the same automatic path**, and that
is deliberate: `usr_5e6d0000-0000-4000-8000-000000000006`
(`s6-drill@test.example`), wiped clean on 2026-09-04, is a completed wipe like
any other, so the first `*/15` tick after S4 deploys tears it down. Letting
that happen unattended **is** the rehearsal S6 exists for — watch it rather
than arrange around it.

An earlier revision of S4 special-cased this tenant id in `src/account-wipe.ts`
to hold it back. That was removed before merge and should not come back. Two
reasons worth writing down, because the idea is tempting each time a fixture
needs protecting:

- The exemption was a bare id comparison in Worker source with no environment
  gate, so it shipped to production. An account with that id there would have
  been silently excluded from an irreversible deletion path, visible only as a
  log line — a deletion-compliance failure, not an operational one. It also
  contradicted the rule in `src/control-plane/account-delete.ts`: the founder
  is a normal tenant, and no tenant is silently special-cased.
- Its release was `wipe_progress.force`, which already means "skip the 7-day
  grace / redrive this wipe". Since `force` on an envelope is persisted onto
  the record, an operator redriving the fixture's wipe for any reason would
  have set it and the next tick would have torn the fixture down anyway. The
  hold did not hold.

To observe the rehearsal, watch for `account_teardown_complete` on that tenant
id, then confirm the `account_deletions` row exists and the `users` row is
gone. Do not delete anything by hand.

## Diagnosing a single reading

`GET /api/readings/:id/diagnostics` shows whether the by-id and by-url pointers
line up, which R2 objects exist, the list-index row, and the recent attempt
records — including which stage failed (`fetch_source`, `embed_source`,
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
| `npm run ops -- corpus migrate-founder` | copy the global layout into the founder tenant namespace and re-upsert vectors (plan doubles as the reconciliation check) |

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
well — do not copy the wrong one.

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
halves — an R2 credential for the manifests and a Cloudflare API token for
Vectorize, which has no S3 access-key path — so R2 keys alone stay on wrangler.
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
block: one row per phase the pass used (`list read`, `planning reads` — the
manifests read while planning — `manifest read` for reads outside a planning
pass, `vectorize query`, `reverse query` — the scoping queries an incremental
tier-1 pass makes, kept apart from the measurement ones because the scope
trades one for the other — `run marker`, `provider`, `manifest write`,
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
surfaces as a `RateLimitedError` naming the retry-after the provider asked for
— that one is what the execute pass's global backoff reacts to (below).

Those limits are these two commands' policy and nothing else's. The other ops
commands that talk to R2 over the S3 API — `corpus ingest`, `corpus recover`,
`corpus migrate-founder`, `corpus purge-connections`, `staging teardown` — keep
the single attempt and the absent deadline they were written and run against.

`refresh-neighbours` is the one exception, and only in part: it gets the same
deadline and retry for its manifest reads and writes whenever it runs direct
over S3 keys. Everything else is still uncovered. The Cloudflare REST client —
the R2 fallback used when only `CLOUDFLARE_API_TOKEN` is set, and every
Vectorize query on the direct path — backs off on 429 but has no deadline and
no 5xx retry; the wrangler subprocesses have neither; and the judgement calls
retry but carry no deadline of their own. A stall on any of them still looks
like a silent pass — the `Timing:` block is what makes it visible.

`ops corpus refresh-neighbours` re-queries Vectorize by the stored vector id of
each ready reading in scope — by default the readings that moved since the run
marker, and under `--full` every one of them, per **Scope** below — with no
embedding calls and no LLM. It prints the staleness inventory,
and always writes its report (`--out`, default `./refresh-report.json`; give
each writer its own path, see below) — the input contract for later
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
`--full` is the explicit sweep: every ready reading, O(N) whatever changed —
the immediate rerun in run A measured 553 readings in 16 minutes and wrote none
of them. (That 16 minutes is the wrangler path; the same sweep on the now-default
direct path models at ~3.5–4 min — see the staging proof below. The argument for
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
first run, a deleted one, or one written before this check existed — the marker
is version 2 and a version-1 marker is rejected with a message that says so), a
marker invalidated by `corpus backfill-vectors`, a reading the marker recorded
that has since left the list (a purge names nothing a timestamp can find), a
failed reverse query, a changed *ready*
reading with no vector to scope from, or a reverse neighbourhood that came back
full at topK with no match below the bound, meaning the query was truncated and
the real set is unknown — never a narrower pass. A short result is a complete
one, so an isolated reading, whose only match is itself, does not escalate. An
escalation reports how many of the changed readings caused it and names the
first, because a corpus that saturates most nights is buying nothing from the
narrowed scope — that rate is the number to watch, and a corpus that escalates
every night should be run as `--full` outright rather than paying the reverse
queries first.

An incremental report is a statement about its scope, not about the corpus: a
persistent flag on a reading nobody touched — the backfill's 394
`connection_below_floor` rows, say — stays invisible until that reading enters
scope. **The weekly `--full` sweep is what makes the default safe, and it is
scheduled by the operator, outside this repository** — nothing in git schedules
a corpus refresh pass (the `crons` triggers in `wrangler.toml` drive the
Worker's own scheduled handler, not these commands), so see "Refresh exit codes"
for the wrapper an operator's cron wants. If
nothing sweeps, those persistent flags never resurface and the served
`similarity` numbers drift indefinitely.

A reading the scope does bring in is measured like any other target, so its
`similarity` snapshot and its list row are brought current in the same pass —
nothing about being in scope defers a measurement to the sweep.

**What an incremental pass keeps exact, and what it only keeps approximate.**
Flags are exact: the bound is derived so that a reading further away than it
cannot gain or lose a *floored* neighbour because one vector changed. The
stored `similarity` snapshot is not, and this is broader than the moved-vector
case above. That snapshot — and the `index/list.json` row the API and the SPA
serve — summarises the **raw** topK, sub-floor scores included, so a vector
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
stamps `invalidated_by` on the marker before its first upsert — and again, with
a different value, after its last — so the next pass sweeps on its own. That
marker is the only R2 object it writes, and it needs an R2 write credential for
it; a stamp it cannot write before upserting stops the run before it spends
anything. A refresh pass that finds a stamp it did not start with leaves the
marker alone rather than clearing a sweep it did not perform, which is what the
second stamp is for: a pass that swept while vectors were still arriving must
not report the corpus as covered.

**Staging proof, 2026-09-02** — the measurement the default flip rests on
(`reading-lite-staging`, 39→47 readings, direct S3/REST path, `--tenant
global`; eight `--execute --sole-writer` passes, all exit 0). Passes 1–5 are the
protocol proper — full → incremental (quiet) → ingest 8 URLs → incremental →
full → full; 6–8 were added to price a second quiet night and to exercise the
escalation path deliberately. All eight, in order:

| # | invocation | scope taken | measured | wall | flagged |
|---|---|---|---|---|---|
| 1 | `--full` | full | 29 | 10.75 s | 0 |
| 2 | `--since-last-run` | incremental (0) | 0 | 1.00 s | 0 |
| — | *ingest leg, 8 URLs → 4 ready + 4 failed* | — | — | 118 s | — |
| 3 | `--since-last-run` | incremental (8) | 4 | 6.72 s | 2 |
| 4 | `--full` | full | 33 | 14.09 s | 2 |
| 5 | `--full` (immediate rerun) | full | 33 | 11.80 s | 2 |
| 6 | `--since-last-run` | incremental (0) | 0 | **0.98 s** | 0 |
| 7 | `--since-last-run` | **escalated** — 1 reading purged | 33 | 12.75 s | 2 |
| 8 | `--since-last-run` | **escalated** — 3 readings purged | 33 | 13.54 s | 2 |

Five of the eight were `--since-last-run` (2, 3, 6, 7, 8), which is the
denominator for the escalation rate below.

- **Flags were byte-identical** between the incremental pass and the sweep
  taken 19 seconds later: same two ids, same `connections`,
  `current_neighbours`, `novelty_verdict`, `reasons`, `judged_at`. The narrowed
  scope missed no flag.
- **Snapshot drift elsewhere was not zero, by design.** The sweep after the
  incremental rewrote two snapshots the incremental never measured — both X
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
  reads a manifest — provided the marker carries no still-ready
  `unmeasurable_ids`, each of which costs a query and a manifest read on even
  the quietest night, by design. The measured runs took the ETag short-circuit (an unchanged
  `index/list.json` ETag ends the scope immediately), but the win does not
  depend on it — where no ETag is available, which is every wrangler-path run
  and any pass whose predecessor wrote a snapshot, `changedSince` falls back to
  the row timestamps and reaches the same empty scope. Modelled onto production (N=553 ready,
  unit costs 0.206 s per Vectorize query + 0.140 s per manifest read, plus the
  4 req/s Cloudflare cap): a sweep is ~3.5–4 min and an incremental night with
  ~10 changed readings ~15 s; at 10x corpus that is ~35–40 min against the same
  ~15 s.
- **Tier 1 spends no LLM or embedding tokens at all** — 0 across all eight
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
is repaired, and exits 3 so it stays visible — the marker advances past it
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
from the marker — so it reaches the same verdict on the first pass as on the
hundredth, with no marker to bootstrap from. An incremental scope is routinely
one or two readings, often exactly the ones carried under `unmeasurable_ids` for
retry; calling that a configuration failure would freeze the marker on a single
broken reading, grow the scope every night, and page for it forever. On any
night that a ready reading changed, a misconfiguration surfaces anyway — that
reading's vector cannot be found, which escalates the scope to a sweep, and the
sweep reports it. On a night when nothing changed at all it does not: the scope
is then whatever an earlier pass carried under `unmeasurable_ids` — those all
answer "no vector" and the pass exits 3 — or, if no pass ever got far enough to
record any, nothing at all, and it exits 0. **The weekly `--full` sweep is the
only guaranteed detector**, which is one more reason to keep it scheduled. A pass narrowed by `--only` or by a
`--limit` that truncated it never reports a configuration failure either — it
measured the subset it was told to, so naming one broken reading with `--only`
exits 3, not 1. Nor does a pass that threw partway through: the targets after
the throw were never attempted, so it reports the abort and exits 1 on that.

There is no minimum corpus size, so a small tenant — a staging or dev corpus of
one or two ready readings, both genuinely vectorless — sweeps, reports a
configuration failure, and stays there until someone repairs or re-embeds them:
exit 1 on every sweep, marker frozen. That is the intended
reading of the evidence (a corpus in which nothing is measurable is not a corpus
you can refresh), and on a corpus that small a permanent sweep costs nothing.
The production corpus is in no danger of it by size: a sweep there measures
hundreds of readings, so the condition cannot fire unless the index really is
unreachable. It can fire by state, though — a Vectorize namespace cutover that
has migrated R2 but not yet re-upserted the vectors leaves every ready reading
vectorless, which is what this condition is built to notice. Every sweep will
exit 1 for the length of such a window — while the nightly `--since-last-run`
may well go quiet, since a cutover moves no list rows — so pause the schedule or
finish the re-upsert (`corpus backfill-vectors`) before relying on either.

`--only <id>` overrides the scope: a named reading is measured whether or not
the scope would have selected it, and the pass resolves no scope at all rather
than paying for reverse queries it cannot use. The header then reads
`Scope: full — --only names N reading(s)`. `--limit` is different: it still
resolves its scope and then measures the first N of it, so the header and the
report keep saying `incremental`. The report records the narrowing under
`scope.narrowed_by` — always for `--only`, and for `--limit` only when it
actually cut the pass short, so the report and the marker agree about whether
the pass was partial. `--only` never advances the marker; `--limit` pins it
only when it actually cut the pass short, so a limit carried in a cron as a
cost valve and never reached still advances it.

Only a complete `--execute` pass advances the marker — a plan pass writes no
snapshots, `--only` names a subset, and a `--limit` that truncated the plan
measured one — and `last_full_run_at` moves only on a full sweep. A failed
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

Give every writer of a refresh report its **own `--out` path** — the nightly,
the weekly sweep, and any ad-hoc run — and point each schedule's tier-2/3 run at
its own report:

```sh
# Weekly, consuming the sweep — not the nightly report.
npm run ops -- corpus refresh-connections \
  --tenant "$TENANT" --report ./refresh-report-full.json
npm run ops -- corpus refresh-tensions \
  --tenant "$TENANT" --report ./refresh-report-full.json
```

Both tiers default to `./refresh-report.json`, and an incremental report is a
statement about its scope: sharing one path would let a nightly pass — or an
ad-hoc interactive one — overwrite the sweep's corpus-wide report with a
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
| 1 | Real work left undone, and the marker did not move past it: a configuration failure (above), a failed Vectorize query, an unparseable manifest, a failed manifest write, or a failed `index/list.json` flush. | operator — re-run, or fix the index/credentials first |
| 2 | Usage error: an unknown flag or a missing `--tenant` (the dispatcher), or a refusal of the same shape from the command itself — `--execute` without `--sole-writer`, `--since-last-run` with `--full`, `--via direct` with `--local`, a non-integer `--limit`. | operator — fix the invocation |
| 3 | The pass itself completed, but specific readings need a human: no indexed vector, or a manifest that fails `ManifestSchema`. | someone — repair those readings (`corpus backfill-vectors`, `corpus recover`); re-running changes nothing |

The line between 1 and 3 is whether re-running the same command could help. It
can after a 1 and cannot after a 3, which is why a 3 is not a page: on a pass
eligible to advance the marker, the ids are carried under `unmeasurable_ids` and
every later pass retries them. The exit line says whether the marker actually
moved, because the passes that never advance it — a plan pass, `--only`, a
truncating `--limit`, an invalidation arriving mid-pass — can all exit 3 too.

The codes apply in plan mode as well as under `--execute`; a dry run reports
what it found. Two existing behaviours change, in opposite directions, so a
scheduled run wants the `case` below rather than a bare `if`: a pass that finds
a reading with no indexed vector used to exit 0 in plan mode and now exits 3
(or 1 if the sweep measured nothing at all), while a pass whose only complaint
is an unmeasurable reading — no vector, or a manifest failing `ManifestSchema`
— used to exit 1 and now exits 3. A wrapper that pages on 1 stops paging for
that second case, which is the point: it is a ticket, not a page.

There is no cron wrapper script in this repository, and nothing in git schedules
a refresh pass — the nightly and weekly invocations above are scheduled by the
operator, directly —
so a scheduler wanting this distinction has to make it itself (the same `case`
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
non-zero cause they have — a planning read that failed, a judgement that failed,
a lost manifest CAS, a `--max-backoff` ceiling, and for `refresh-connections`
the `index/list.json` flush it alone performs — is a re-run-or-fix case, which
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
(12 reading(s)) — …`, `Scope: full — …`, or `Scope: unstated` when the report
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
id, and replaces only `connections`, `novelty_verdict`, and
`connections_computed_at`. Manifest writes use ETag CAS against the ETag the
planning read returned — execute re-reads nothing — so a manifest that changed
between the plan and the write loses that conditional write and is reported as
a CAS loss. The judgement is made before that write, so a CAS loss is a
judgement already paid for and thrown away — a run of them is a run of wasted
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
many, defaulting to 4 — the ingest queue runs at 3 against the same provider
account, so this is deliberately close to it — and refusing anything above 16,
so a mistyped flag cannot fan a hundred paid calls at that account. Results are
collected and printed in plan order however the calls complete, and every
counter (`Judged`, `list rows healed`, `failures`, `Usage:`) is folded in that
same order, so a run's output and its exit code do not depend on which call
returned first. The lines that are not in plan order are the rate-limit pause
and the backoff ceiling below, which print when they happen because that is the
point of them. The cost of that ordering is that a finished action's line waits
for the ones planned before it, so a single slow call holds back the lines
behind it; the `Timing:` block at the end is still what separates a slow pass
from a hung one. Pass `--concurrency 1` for a strictly sequential pass — the
rate-limit backoff below still applies.

Two things the pass does not do concurrently. It never has two judgements
holding the same reading at once — in `refresh-tensions`, where a reading sits
in several pairs, an action waits until every reading it writes is free, so
concurrency cannot manufacture a lost CAS or pay for a judgement it then throws
away. And when a judgement comes back rate limited, the whole pass backs off
together. The judge's own retry never covers a 429 — it retries 5xx and network
faults, and turns the first 429 into a typed error immediately rather than
sleeping inside the provider call — so this backoff is the only thing pacing a
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
now fails at parse time rather than running unbounded — `2h` was a documented
example here and is no longer accepted.

What counts against it is the
window each limit opens, not each worker that reports one, so a whole round of
workers walking into the same wall is a single charge — and a limit landing
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
still making progress between windows. That is deliberate — the bound is on how
much of the sole-writer window a pass may spend waiting, not on how badly it is
being limited — but it is the case to raise `--max-backoff` for, up to its `30m`
ceiling. A pass that still cannot finish inside that is one to split with
`--limit` and resume when the provider is quieter, not one to park on the
sole-writer window for hours.

The ceiling bounds the paid work only, on the same rule as `--limit`: a list
heal or an integrity repair makes no provider call and cannot be rate limited,
so the pass still runs the free work behind the ceiling before it exits.

Ctrl-C is safe at any point: every manifest write is a completed CAS, and a
rerun resumes from the manifests as it always does.

Because the calls overlap, every `Timing:` row a concurrent action produces —
`provider`, `manifest write`, and for `refresh-tensions` `manifest read` — sums
the call durations rather than the wall time they occupied, the same way
`planning reads` already did, so under `--concurrency` a row can exceed the
run's own total. The `total` row is the one to compare between runs.

Run a fresh neighbour refresh immediately before this command. The report must
name the same `--tenant`; a mismatched selector is refused. The sole-writer
window must cover provider calls, manifest CAS writes, and the final wholesale
`index/list.json` put. The command also refuses the report if a target or
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
each side's directional entry — `contradicts` (symmetric), `supersedes` /
`superseded_by`, `qualifies` / `qualified_by`, always from that reading's point
of view with one shared reason — plus a `tensions_judged` record to BOTH
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

Production cutover (HITL gates, freeze, repair, copy, gate flip, verify,
rollback, observation) is [`docs/founder-cutover.md`](founder-cutover.md),
written from the 2026-08-27 staging rehearsal. This section is the command.

`ops corpus migrate-founder` moves the pre-tenant corpus into the founder's
tenant namespace as a **copy, never a move**: every global-layout object is
copied byte-identically to `u/{tenantId}/{same key}` (stored `key_prefix`
values are root-relative, so no object body changes), and every ready
reading's vector is re-read by id and re-upserted into the tenant namespace
as `{tenantId}:{readingId}` with `tenant_id` metadata (ADR 0002) — no paid
re-embedding. Legacy objects and vectors are always retained; the command
never deletes anything.

```sh
# Exact dry-run: every copy (size+etag), every vector upsert, every problem.
# --tenant is the DESTINATION founder id (from whoami); source is always global.
npm run ops -- corpus migrate-founder --tenant "$TENANT"

# Copy + migrate vectors, resumably (state file records per-object sha256):
npm run ops -- corpus migrate-founder --tenant "$TENANT" --execute --sole-writer

# Reconcile: plan again — "fully migrated" means every source object exists
# at its tenant key with equal size/etag, every ready row has its namespaced
# vector carrying the legacy embedding and metadata, and every row agrees
# with the manifest and by-id pointer it names.
npm run ops -- corpus migrate-founder --tenant "$TENANT"
```

Certification is a content check, not a presence check: the plan parses each
row's `manifest.json` and by-id pointer and blocks when they disagree with
the row (`row_manifest_mismatch`, `row_by_id_pointer_invalid`). A stale
`index/list.json` row is the case that matters — the vector plan follows the
row's `status`, so a row saying `failed` over a `ready` manifest would migrate
with no vector planned. Repair those with `corpus rebuild-list --tenant
global` (the migrate-founder source is the pre-tenant layout, not
`$TENANT`), then re-plan.

That costs two reads per row the first time. After that the state file caches
each parse against the object's etag, so passes over an unmoved corpus read
nothing — every pass prints `Verified N row(s) … (R object reads, C served
from the state file's etag cache)`, and a high `R` on a corpus you have not
touched means the cache is not being reused (no state file yet, or a
different `--state` path). Pass the same `--state` to plan and execute to
keep it warm. Plan mode reads that file and never writes it. The cache holds
what the objects *said*, never whether they passed: the row comparison always
re-runs against the live `index/list.json`, so a row that goes stale while
its manifest sits untouched is still caught.

Both modes need an account id plus either S3 `CORPUS_R2_*` keys or
`CLOUDFLARE_API_TOKEN` / `CORPUS_CF_API_TOKEN` (R2 REST). Plan reads live
listings, per-row manifest/pointer content, and vector state.
`--limit` caps work per pass for interrupted-run rehearsal; the
tenant-stamped state file refuses resumes under a different tenant, bucket,
or index.

Cutover ordering, gate-flip commands, and the staging-rehearsal pitfalls
(stale `index/list.json`, missing vectors, Vectorize `get_by_ids` cap of 20,
`--var` vs `ops deploy worker`) are in
[`docs/founder-cutover.md`](founder-cutover.md). Rollback before the flip is
"don't flip"; after, unset the gate and redeploy **while the writer is still
frozen**. Post-pin writes exist only under tenant roots, so a rollback after
writes resume needs freeze + reverse reconciliation or accepted loss. Legacy
state survives until post-observation sign-off (ADR 0001).

### The extract-agent

The Worker enforces per-hop scheme, DNS-vs-private, redirect, size, and time
limits on every extraction fetch. Cloudflare private-egress blocking is not
that contract. Some sites still hard-block datacenter egress, so
`fetch_source` fails where a residential IP succeeds. `ops extract agent` is
operator-local recovery: it polls the reading API for `fetch_source`-failed
readings and re-extracts them locally — an SSRF-guarded static tier with
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
  --folder "Computing/AI/MCP" --url https://reading-lite.bbell.dev/api/readings
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
index is safe — it just re-POSTs every URL once to rebuild it.

### Local markdown

Imports `.md` files without re-fetching their source URLs. Each file must carry
a source line:

```md
**Source:** https://example.com/article
```

That URL becomes the canonical reading URL and the body is sent to
`POST /api/readings/import-markdown`. Duplicate files sharing a source URL are
collapsed before submit — the largest file wins. Imported readings store the
markdown as both raw content and `extracted.md`, then reuse the normal
embedding, similarity, summary, Vectorize, manifest, and list-index pipeline.

```sh
npm run ops -- import markdown --dir ~/Documents/articles           # plan, no token needed
npm run ops -- import markdown --dir ~/Documents/articles --execute  # local dev
npm run ops -- import markdown --dir ~/Documents/articles --execute \
  --url https://reading-lite.bbell.dev/api/readings/import-markdown
```

`--url` is the full import endpoint; token resolution matches the other scripts.
Files above the Cloudflare Queues 128 KB message limit are blocked before any
POST. Successful new/existing responses are recorded in
`.import-markdown-index.json` (scoped by destination URL) and move every file
for that source URL into a `processed/` subdirectory. Email is off by default;
pass `--email` to request notifications.

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
persisted — a companion `<sidecar>.input.jsonl` holds the exact JSONL bytes,
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
**existing production readings**, use the compare-summary-effort skill — not
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
thread JSON — `POST /api/readings` with a `reddit.com` / `redd.it` URL
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
from the public oEmbed metadata (title + author — the reliable floor), plus a
best-effort description (from the page's `ytInitialPlayerResponse`) and
transcript (the first caption track) when YouTube serves them. Unlike Reddit the
URL summarizes to `ready` directly, but in practice the Worker is usually blocked
from the watch page and lands the floor only.

For a full extraction — description plus transcript — run the
**`youtube-import`** skill locally, which fetches the watch page from your
residential IP and uses `yt-dlp` for the transcript, then imports the rich
markdown through the same parsers the Worker uses. Requires `yt-dlp` on PATH.

```sh
npm run ops -- import youtube "<youtubeUrl>" --execute   # omit --execute to preview
```

## Seeding local R2

To exercise the read path or the SPA against real data locally, seed the local
bucket and then restart `wrangler dev` — the running dev server caches R2
in-process. Seed via **Miniflare** (persist path `.wrangler/state/v3/r2`, bucket
`reading-lite`), *not* `wrangler r2 object put --local`, which writes to a
different local store the dev server never reads.

A minimal `ready` reading needs:

- `readings/<key_prefix>/manifest.json` — a valid `ManifestSchema` with
  `content_status: "captured"`
- `index/by-id/<id>`
- `index/by-url/<url_hash>` — matching the manifest's `url_hash`
- a row in `index/list.json`
- `readings/<key_prefix>/extracted.md` — for `/content`
- `readings/<key_prefix>/raw.{ext}` matching the manifest's `content_type` — for
  `/content/raw`

`/lookup` requires the by-url pointer and does not discover pointerless readings.
